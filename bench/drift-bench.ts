#!/usr/bin/env bun
/**
 * Measure what drift pays per source for citations that cross sources (#192, #239).
 * Each page cites its own source and two others; one in twenty has a cross-source canonical_source.
 */
import { mkdtempSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildIndex,
  detectDrift,
  openIndex,
  parseConfig,
  type Database,
  type LocationVerdict,
  type LocatorChange,
  type SourceAdapter,
} from "@accreta/core";

const SIZES = ((): number[] => {
  const arg = process.argv.find((a) => a.startsWith("--sizes="));
  if (arg) return arg.slice("--sizes=".length).split(",").map(Number);
  return [1_000, 10_000];
})();
const RUNS = 7;
const SOURCES = Array.from({ length: 10 }, (_, i) => `src-${i}`);

const CONFIG_YAML = `knowledge_base: knowledge
page_types: [note]
`;

// The SQL citationsInto runs, kept in step with packages/core/src/source/drift.ts.
const CANONICAL_SQL = `SELECT page_path AS path, canonical_source FROM canonical_cites WHERE source = $source`;
// What it ran before #239, so the bench still measures a commit without canonical_cites.
const CANONICAL_SQL_BEFORE = `SELECT path, canonical_source FROM pages
  WHERE (source IS NULL OR source <> $source) AND instr(canonical_source, $source || ':') > 0`;
const FOOTNOTE_SQL = `SELECT page_path, footnote, revision, path, locator FROM citations
  WHERE source = $source AND path IS NOT NULL ORDER BY page_path, line`;

const WORDS = "forcing feedback sensitivity budget aerosol permafrost albedo radiative flux".split(
  " ",
);

function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

function generate(n: number): string {
  const rng = makeRng(42);
  const root = mkdtempSync(join(tmpdir(), "accreta-drift-bench-"));
  const knowledge = join(root, "knowledge");
  mkdirSync(knowledge, { recursive: true });
  writeFileSync(join(root, "accreta.config.yaml"), CONFIG_YAML);
  const pick = () => SOURCES[Math.floor(rng() * SOURCES.length)]!;
  // 200 files by 50 ranges, so a cache of `locate` answers does not hide the corpus's size.
  const file = () => {
    const line = 1 + Math.floor(rng() * 50);
    return `docs/file-${Math.floor(rng() * 200)}.md#L${line}-L${line + 4}`;
  };

  for (let i = 0; i < n; i++) {
    const own = SOURCES[i % SOURCES.length]!;
    const canonical = i % 20 === 0 ? SOURCES[(i + 1) % SOURCES.length]! : own;
    const body = Array.from({ length: 120 }, () => WORDS[Math.floor(rng() * WORDS.length)]).join(
      " ",
    );
    const page = `---
type: note
title: Page ${i}
source: ${own}
canonical_source: "${canonical}:docs/file-${i % 200}.md#L1-L5"
last_verified_revision: r0
---

# Page ${i}

${body} A claim.[^1] Another.[^2] A third.[^3]

[^1]: ${own} @ r0 · ${file()}
[^2]: ${pick()} @ r0 · ${file()}
[^3]: ${pick()} @ r0 · ${file()}
`;
    writeFileSync(join(knowledge, `page-${String(i).padStart(6, "0")}.md`), page);
  }
  return root;
}

// No parameter properties: Node's type stripping refuses them, and this bench runs on Node too.
class MovedSource implements SourceAdapter {
  readonly id: string;
  constructor(id: string) {
    this.id = id;
  }
  async revision(): Promise<string> {
    return "r1";
  }
  async changedSince(): Promise<string[]> {
    return ["docs/file-0.md", "docs/file-1.md", "docs/file-2.md"];
  }
  locates = 0;
  async locate(): Promise<LocationVerdict> {
    this.locates++;
    return { verdict: "found" };
  }
  citation(path: string): string {
    return `${this.id}:${path}`;
  }
  pinRevision(): void {}
}

// Ranks pages by their cited lines, so drift asks `locate` about the citations it would clear (#303).
class DiffingSource extends MovedSource {
  async touchedSince(
    _revision: string,
    _path: string,
    locators: readonly string[],
  ): Promise<Map<string, LocatorChange>> {
    return new Map(locators.map((locator) => [locator, { status: "untouched" }]));
  }
}

const perCall = (sources: MovedSource[]) =>
  sources.reduce((n, a) => n + a.locates, 0) / (RUNS * sources.length);

function median(samples: number[]): number {
  const sorted = samples.toSorted((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

function plan(db: Database, sql: string): string {
  const rows = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all({ $source: SOURCES[0]! }) as {
    detail: string;
  }[];
  return rows.map((r) => r.detail).join(" | ");
}

async function measure(size: number) {
  const root = generate(size);
  try {
    const indexPath = join(root, ".accreta", "index.sqlite");
    const build = buildIndex({ root, config: parseConfig(CONFIG_YAML), indexPath });
    const db = openIndex(indexPath, { readonly: true });
    const hasTable = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'canonical_cites'")
      .get();
    const canonicalSql = hasTable ? CANONICAL_SQL : CANONICAL_SQL_BEFORE;
    const adapters = SOURCES.map((id) => new MovedSource(id));
    const diffing = SOURCES.map((id) => new DiffingSource(id));
    const drift: number[] = [];
    const lines: number[] = [];
    const canonical: number[] = [];
    const footnotes: number[] = [];
    await detectDrift(db, adapters[0]!);
    await detectDrift(db, diffing[0]!);
    for (const a of [...adapters, ...diffing]) a.locates = 0;
    for (let run = 0; run < RUNS; run++) {
      for (const adapter of adapters) {
        let t0 = performance.now();
        await detectDrift(db, adapter);
        drift.push(performance.now() - t0);
        t0 = performance.now();
        await detectDrift(db, diffing[adapters.indexOf(adapter)]!);
        lines.push(performance.now() - t0);
        t0 = performance.now();
        db.prepare(canonicalSql).all({ $source: adapter.id });
        canonical.push(performance.now() - t0);
        t0 = performance.now();
        db.prepare(FOOTNOTE_SQL).all({ $source: adapter.id });
        footnotes.push(performance.now() - t0);
      }
    }
    const plans = { canonical: plan(db, canonicalSql), footnotes: plan(db, FOOTNOTE_SQL) };
    db.close();
    return {
      pages: build.pages,
      citations: build.citations,
      indexBytes: statSync(indexPath).size,
      buildMs: build.ms,
      driftMs: median(drift),
      linesMs: median(lines),
      locates: perCall(adapters),
      linesLocates: perCall(diffing),
      canonicalMs: median(canonical),
      footnoteMs: median(footnotes),
      plans,
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const runtime = typeof Bun === "undefined" ? `node ${process.versions.node}` : `bun ${Bun.version}`;
console.log(`platform: ${process.platform} ${process.arch}, ${runtime}`);
console.log(`${SOURCES.length} sources, median of ${RUNS} runs per source\n`);
console.log(
  "  pages  citations     build  index bytes  drift/source  locates  by lines  locates  canonical query  footnote query",
);
const plans: string[] = [];
for (const size of SIZES) {
  const r = await measure(size);
  const ms = (x: number) => `${x.toFixed(2)}ms`;
  console.log(
    `  ${String(r.pages).padStart(5)}  ${String(r.citations).padStart(9)}  ${ms(r.buildMs).padStart(8)}  ${String(r.indexBytes).padStart(11)}  ${ms(r.driftMs).padStart(12)}  ${String(r.locates).padStart(7)}  ${ms(r.linesMs).padStart(8)}  ${String(r.linesLocates).padStart(7)}  ${ms(r.canonicalMs).padStart(15)}  ${ms(r.footnoteMs).padStart(14)}`,
  );
  plans.push(
    `  ${r.pages} canonical: ${r.plans.canonical}`,
    `  ${r.pages} footnotes: ${r.plans.footnotes}`,
  );
}
console.log("\nQUERY PLANS");
for (const line of plans) console.log(line);
