#!/usr/bin/env bun
// findCanonical latency and rebuild time by corpus size; probes vary how many rows a term touches.
// Uniform links: findCanonical never follows them, and scale-bench's generator is quadratic.
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// A namespace import, so the query mode still loads against commits that predate nameKey.
import * as core from "@accreta/core";

const { buildIndex, findCanonical, openIndex, parseConfig } = core;

const arg = (name: string, fallback: string) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const SIZES = arg("sizes", "1000,10000").split(",").map(Number);
const RUNS = Number(arg("runs", "31"));
const BUILDS = Number(arg("builds", "3"));
const INSERTS = process.argv.includes("--inserts");

const CONFIG_YAML = `knowledge_base: knowledge
page_types: [note, concept, decision, synthesis]
link_fields: [related]
`;

const WORDS = `forcing feedback sensitivity budget aerosol permafrost albedo radiative flux ocean
   uptake carbon methane emission scenario projection anomaly baseline threshold cascade`
  .split(/\s+/)
  .filter(Boolean);

function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

const PROBES = [
  { name: "one page", term: "needle in the haystack", expected: (_n: number) => 1 },
  { name: "tenth of pages", term: "shared alias", expected: (n: number) => Math.ceil(n / 10) },
  { name: "in every frontmatter", term: "synthetic", expected: (_n: number) => 0 },
  { name: "nowhere", term: "not a concept here", expected: (_n: number) => 0 },
  { name: "title", term: "Page 7", expected: (_n: number) => 1 },
] as const;

function aliasesFor(i: number, n: number): string[] {
  const aliases: string[] = [];
  if (i === Math.floor(n / 2)) aliases.push("needle in the haystack");
  if (i % 10 === 0) aliases.push("shared alias", `alias ${i}`);
  return aliases;
}

function generate(n: number): string {
  const rng = makeRng(42);
  const root = mkdtempSync(join(tmpdir(), "accreta-canonical-"));
  const knowledge = join(root, "knowledge");
  mkdirSync(knowledge, { recursive: true });
  const types = ["note", "concept", "decision", "synthesis"];
  const name = (i: number) => `page-${String(i).padStart(6, "0")}`;
  for (let i = 0; i < n; i++) {
    const aliases = aliasesFor(i, n);
    const related = Array.from(
      { length: Math.min(4, i) },
      () => `[[${name(Math.floor(rng() * i))}]]`,
    );
    const body = Array.from({ length: 120 }, () => WORDS[Math.floor(rng() * WORDS.length)]).join(
      " ",
    );
    writeFileSync(
      join(knowledge, `${name(i)}.md`),
      `---
type: ${types[i % types.length]}
title: Page ${i}
source: synthetic${aliases.length > 0 ? `\naliases: ${JSON.stringify(aliases)}` : ""}
canonical_source: "synthetic:corpus/page-${i}.md#L1"
related: ${related.length > 0 ? related.join(", ") : "[]"}
---

# Page ${i}

${body}
`,
    );
  }
  return root;
}

function median(samples: number[]): number {
  const sorted = samples.toSorted((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

const fmt = (x: number) => (x < 1 ? x.toFixed(3) : x < 10 ? x.toFixed(2) : x.toFixed(0));

// Times only the rows #82 added to the rebuild, against the same schema with them left out.
function insertOnly(n: number, variant: "full" | "no title key" | "no aliases"): number {
  const dir = mkdtempSync(join(tmpdir(), "accreta-inserts-"));
  try {
    const db = openIndex(join(dir, "index.sqlite"));
    if (variant === "no title key") db.exec("DROP INDEX idx_pages_title_key");
    const page = db.prepare(
      `INSERT INTO pages (path, type, title, title_key, source, canonical_source, frontmatter_json, body, mtime)
       VALUES ($path, 'note', $title, $key, 'synthetic', $cs, $fm, $body, 0)`,
    );
    const alias = db.prepare(`INSERT OR IGNORE INTO aliases (alias, path) VALUES ($alias, $path)`);
    const body = WORDS.join(" ").repeat(6);
    db.exec("BEGIN");
    const t0 = performance.now();
    for (let i = 0; i < n; i++) {
      const path = `knowledge/page-${String(i).padStart(6, "0")}.md`;
      const title = `Page ${i}`;
      const aliases = aliasesFor(i, n);
      page.run({
        $path: path,
        $title: title,
        $key: variant === "no title key" ? null : core.nameKey(title),
        $cs: `synthetic:corpus/page-${i}.md#L1`,
        $fm: JSON.stringify({ type: "note", title, aliases }),
        $body: body,
      });
      if (variant === "no aliases") continue;
      for (const a of aliases) alias.run({ $alias: core.nameKey(a), $path: path });
    }
    const ms = performance.now() - t0;
    db.exec("COMMIT");
    db.close();
    return ms;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log(`platform: ${process.platform} ${process.arch}, bun ${Bun.version}`);

if (INSERTS) {
  const variants = ["full", "no title key", "no aliases"] as const;
  console.log(`insert-only, ${BUILDS} interleaved runs per variant (median)\n`);
  console.log(`pages     ${variants.map((v) => v.padStart(14)).join("  ")}`);
  for (const n of SIZES) {
    const samples = new Map(variants.map((v) => [v, [] as number[]]));
    for (let r = 0; r < BUILDS; r++) {
      const order = r % 2 === 0 ? variants : variants.toReversed();
      for (const v of order) samples.get(v)!.push(insertOnly(n, v));
    }
    const cells = variants.map((v) => `${fmt(median(samples.get(v)!))}ms`.padStart(14));
    console.log(`${String(n).padStart(7)}  ${cells.join("  ")}`);
  }
} else {
  console.log(`runs per probe: ${RUNS} (median), builds per size: ${BUILDS} (median)\n`);
  console.log(`pages     build_ms  ${PROBES.map((p) => p.name.padStart(20)).join("  ")}`);
  for (const n of SIZES) {
    const root = generate(n);
    try {
      const config = parseConfig(CONFIG_YAML);
      const indexPath = join(root, ".accreta", "index.sqlite");
      const builds: number[] = [];
      for (let b = 0; b < BUILDS; b++) builds.push(buildIndex({ root, config, indexPath }).ms);

      const db = openIndex(indexPath, { readonly: true });
      const cells = PROBES.map((probe) => {
        const got = findCanonical(db, probe.term, config).length;
        if (got !== probe.expected(n)) {
          throw new Error(`${probe.name}: ${got} matches, expected ${probe.expected(n)}`);
        }
        const samples: number[] = [];
        for (let r = 0; r < RUNS; r++) {
          const t0 = performance.now();
          findCanonical(db, probe.term, config);
          samples.push(performance.now() - t0);
        }
        return `${fmt(median(samples))}ms`.padStart(20);
      });
      db.close();
      console.log(
        `${String(n).padStart(7)}  ${fmt(median(builds)).padStart(9)}  ${cells.join("  ")}`,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
}
