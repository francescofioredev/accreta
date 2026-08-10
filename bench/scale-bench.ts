#!/usr/bin/env bun
/**
 * Measure how the index behaves as the knowledge base grows.
 *
 * ADR-0004 rejects incremental indexing on the strength of one number: 43ms for 300
 * pages and 600 links. That is a measurement of the corpus the project had, not of the
 * corpus it might have. A decision taken at 300 pages says nothing about 10^5, and the
 * rebuild sits inside an agent's edit loop — `update_verified_revision` writes markdown
 * and tells the caller to reindex — so its cost is paid on every verification pass.
 *
 * This measures the rebuild and every query path against synthetic corpora spanning
 * three orders of magnitude, so that "when does the filesystem stop making sense" can be
 * answered with a threshold instead of an intuition.
 *
 * The corpora are synthetic and that is a limitation, not a detail: real pages are
 * written by an agent and their link structure reflects what it found worth connecting.
 * What is modelled here is the SHAPE that structure takes — a few hub pages that many
 * things cite, a long tail that nothing points at — because a uniform random graph would
 * flatter `findRelated` by giving it no hubs to choke on.
 */
import { mkdtempSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildIndex,
  findCanonical,
  findRelated,
  getPage,
  lint,
  openIndex,
  parseConfig,
  searchPages,
  type Database,
} from "@accreta/core";

const SIZES = ((): number[] => {
  const arg = process.argv.find((a) => a.startsWith("--sizes="));
  if (arg) return arg.slice("--sizes=".length).split(",").map(Number);
  return [100, 1_000, 10_000];
})();

const CONFIG_YAML = `knowledge_base: knowledge
page_types: [note, source, concept, decision, synthesis]
link_fields: [related, supersedes, superseded_by, discussed_in]
`;

/**
 * Vocabulary for page bodies. Real pages are prose with citations, so the body has to be
 * long enough that FTS5 is indexing something and SQLite is storing something — a corpus
 * of one-line pages would measure the walk and nothing else.
 */
const WORDS = `forcing feedback sensitivity budget aerosol permafrost albedo radiative flux ocean
   uptake carbon methane emission scenario projection anomaly baseline threshold cascade
   attribution reanalysis ensemble hindcast parametrisation grid resolution boundary`
  .split(/\s+/)
  .filter(Boolean);

/** Deterministic PRNG: a benchmark that cannot be re-run identically is an anecdote. */
function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

interface Corpus {
  root: string;
  pages: number;
  /** Path of the most-cited page — the hub `findRelated` has to survive. */
  hubPath: string;
  /** A term declared as an alias on exactly one page, for the findCanonical probe. */
  aliasTerm: string;
}

/**
 * Build a corpus of `n` pages whose in-degree follows preferential attachment: each new
 * page links to `LINKS_PER_PAGE` earlier ones chosen with probability proportional to
 * their existing in-degree. This produces the hub-and-tail shape a compiled knowledge
 * base has, rather than the uniform degree a random graph would give.
 */
function generate(n: number, seed = 42): Corpus {
  const LINKS_PER_PAGE = 4;
  const rng = makeRng(seed);
  const root = mkdtempSync(join(tmpdir(), "accreta-scale-"));
  const knowledge = join(root, "knowledge");
  mkdirSync(knowledge, { recursive: true });
  writeFileSync(join(root, "accreta.config.yaml"), CONFIG_YAML);

  const types = ["note", "concept", "decision", "synthesis"];
  // Cumulative in-degree, used as the preferential-attachment weight.
  const indegree = new Array<number>(n).fill(0);
  const pathOf = (i: number) => `knowledge/page-${String(i).padStart(6, "0")}`;

  for (let i = 0; i < n; i++) {
    const targets = new Set<number>();
    // Total weight so far: every earlier page starts with weight 1 so page 0 is reachable.
    let total = 0;
    for (let j = 0; j < i; j++) total += indegree[j]! + 1;
    for (let k = 0; k < Math.min(LINKS_PER_PAGE, i); k++) {
      let r = rng() * total;
      for (let j = 0; j < i; j++) {
        r -= indegree[j]! + 1;
        if (r <= 0) {
          targets.add(j);
          break;
        }
      }
    }
    for (const t of targets) indegree[t]! += 1;

    const body = Array.from({ length: 120 }, () => WORDS[Math.floor(rng() * WORDS.length)]).join(
      " ",
    );
    const related = [...targets].map((t) => `[[${pathOf(t).replace("knowledge/", "")}]]`);
    // One page carries a distinctive alias, so findCanonical's alias branch is exercised
    // on a corpus where it has to scan past everything else to reach it.
    const aliases = i === Math.floor(n / 2) ? `\naliases: ["needle in the haystack"]` : "";
    const page = `---
type: ${types[i % types.length]}
title: Page ${i}
source: synthetic${aliases}
canonical_source: "synthetic:corpus/page-${i}.md#L1"
last_verified_revision: "0000000000000000000000000000000000000000"
related: ${related.length > 0 ? related.join(", ") : "[]"}
---

# Page ${i}

${body}
`;
    writeFileSync(join(knowledge, `page-${String(i).padStart(6, "0")}.md`), page);
  }

  let hub = 0;
  for (let j = 1; j < n; j++) if (indegree[j]! > indegree[hub]!) hub = j;

  return {
    root,
    pages: n,
    hubPath: `${pathOf(hub)}.md`,
    aliasTerm: "needle in the haystack",
  };
}

/** Median of `runs` timings, in milliseconds. Median, not mean: one GC pause is not signal. */
function timeMs(runs: number, fn: () => void): number {
  const samples: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    fn();
    samples.push(performance.now() - t0);
  }
  samples.sort((a, b) => a - b);
  return samples[Math.floor(samples.length / 2)]!;
}

interface Row {
  pages: number;
  links: number;
  buildMs: number;
  indexBytes: number;
  searchMs: number;
  getPageMs: number;
  findRelatedMs: number;
  findCanonicalMs: number;
  lintMs: number;
  lintFindings: number;
  rssMb: number;
}

function measure(size: number): Row {
  const corpus = generate(size);
  try {
    const config = parseConfig(CONFIG_YAML);
    const indexPath = join(corpus.root, ".accreta", "index.sqlite");

    // Build once for the reported number. The rebuild is the expensive operation and
    // running it repeatedly at 10^5 would dominate the benchmark's own runtime.
    const build = buildIndex({ root: corpus.root, config, indexPath });

    const db: Database = openIndex(indexPath, { readonly: true });
    const searchMs = timeMs(20, () => void searchPages(db, { query: "forcing OR feedback" }));
    const getPageMs = timeMs(20, () => void getPage(db, corpus.hubPath, config));
    const findRelatedMs = timeMs(20, () => void findRelated(db, corpus.hubPath, config, {}));
    const findCanonicalMs = timeMs(5, () => void findCanonical(db, corpus.aliasTerm, config));
    let findings = 0;
    const lintMs = timeMs(3, () => {
      findings = lint(db, config).findings.length;
    });
    db.close();

    return {
      pages: build.pages,
      links: build.links,
      buildMs: build.ms,
      indexBytes: statSync(indexPath).size,
      searchMs,
      getPageMs,
      findRelatedMs,
      findCanonicalMs,
      lintMs,
      lintFindings: findings,
      rssMb: process.memoryUsage().rss / 1024 / 1024,
    };
  } finally {
    rmSync(corpus.root, { recursive: true, force: true });
  }
}

const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)}MB`;
const ms = (x: number) => (x < 1 ? `${x.toFixed(2)}ms` : `${x.toFixed(0)}ms`);

console.log(`platform: ${process.platform} ${process.arch}, bun ${Bun.version}`);
console.log(`sizes: ${SIZES.join(", ")}\n`);

const rows: Row[] = [];
for (const size of SIZES) {
  process.stderr.write(`  measuring ${size} pages...\n`);
  rows.push(measure(size));
}

console.log("REBUILD (wholesale, one transaction — the ADR-0004 decision)");
console.log("  pages     links    build      index      per-page");
for (const r of rows) {
  const perPage = r.buildMs / r.pages;
  console.log(
    `  ${String(r.pages).padStart(7)}  ${String(r.links).padStart(7)}  ${ms(r.buildMs).padStart(8)}  ${mb(r.indexBytes).padStart(8)}  ${perPage.toFixed(3)}ms`,
  );
}

console.log("\nQUERY LATENCY (median)");
console.log("  pages    search   getPage  findRelated  findCanonical      lint  findings");
for (const r of rows) {
  console.log(
    `  ${String(r.pages).padStart(7)}  ${ms(r.searchMs).padStart(7)}  ${ms(r.getPageMs).padStart(8)}  ${ms(r.findRelatedMs).padStart(11)}  ${ms(r.findCanonicalMs).padStart(13)}  ${ms(r.lintMs).padStart(8)}  ${String(r.lintFindings).padStart(8)}`,
  );
}

console.log("\nGROWTH (ratio to the previous size)");
for (let i = 1; i < rows.length; i++) {
  const prev = rows[i - 1]!;
  const cur = rows[i]!;
  const f = (a: number, b: number) => (b === 0 ? "n/a" : `${(a / b).toFixed(1)}x`);
  console.log(
    `  ${prev.pages} -> ${cur.pages} (${f(cur.pages, prev.pages)} pages): ` +
      `build ${f(cur.buildMs, prev.buildMs)}, index ${f(cur.indexBytes, prev.indexBytes)}, ` +
      `findCanonical ${f(cur.findCanonicalMs, prev.findCanonicalMs)}, lint ${f(cur.lintMs, prev.lintMs)}`,
  );
}
