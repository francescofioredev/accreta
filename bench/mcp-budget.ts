#!/usr/bin/env bun
/**
 * Measure what each MCP tool costs the agent that calls it.
 *
 * The consumer of this server is a language model with a finite context window, so every
 * token a tool returns is a token unavailable for reasoning. Only `search_pages` bounds
 * its response — default 20 results, hard maximum 50. `get_page` returns a whole body,
 * and `find_consumers`, `find_canonical`, `check_drift` and `lint_knowledge_base` return
 * everything they find. Whether that matters is not a matter of opinion; it is a number,
 * and this measures it.
 *
 * The failure it exists to quantify is specific and circular: an agent asks
 * `lint_knowledge_base` what is wrong with the knowledge base in order to fix it, and the
 * answer does not fit in the context it would need to do the fixing.
 *
 * Serialisation matches the server exactly — `JSON.stringify(value, null, 2)` wrapped in
 * a single text block, per `packages/mcp-server/src/server.ts` — because the two-space
 * indentation is itself paid for in tokens.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildIndex, openIndex, parseConfig, type AccretaConfig } from "@accreta/core";
import {
  findCanonicalTool,
  findConsumersTool,
  getPageTool,
  lintTool,
  searchPagesTool,
  type ToolContext,
} from "@accreta/mcp-server";

const SIZES = ((): number[] => {
  const arg = process.argv.find((a) => a.startsWith("--sizes="));
  if (arg) return arg.slice("--sizes=".length).split(",").map(Number);
  return [10, 100, 1_000];
})();

const CONFIG_YAML = `knowledge_base: knowledge
page_types: [note, source, concept, decision, synthesis]
link_fields: [related, supersedes, superseded_by, discussed_in]
`;

/**
 * Token estimate. Deliberately crude and deliberately stated: 4 bytes per token is the
 * rule of thumb for English prose under a BPE tokenizer, and JSON with heavy punctuation
 * tokenizes worse than prose, so this UNDERSTATES the real count. It is used to place a
 * number on the right order of magnitude, not to bill anyone.
 */
const TOKENS_PER_BYTE = 1 / 4;
const estTokens = (bytes: number) => Math.round(bytes * TOKENS_PER_BYTE);

/** Exactly what the server sends: one text block of pretty-printed JSON. */
function serialize(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value, null, 2), "utf-8");
}

interface Corpus {
  root: string;
  hubPath: string;
}

/**
 * A corpus in the state a knowledge base is in when an agent most needs to lint it:
 * pages missing provenance and missing a verified revision, and links that point at
 * nothing. Every page here produces at least two lint findings, which is not pessimistic
 * — it is what a half-finished ingest looks like.
 */
function generate(n: number): Corpus {
  const root = mkdtempSync(join(tmpdir(), "accreta-mcp-budget-"));
  const knowledge = join(root, "knowledge");
  mkdirSync(knowledge, { recursive: true });
  writeFileSync(join(root, "accreta.config.yaml"), CONFIG_YAML);

  const body = Array.from(
    { length: 400 },
    (_, i) => `Sentence ${i} about radiative forcing, feedback strength and carbon budget.`,
  ).join(" ");

  for (let i = 0; i < n; i++) {
    const id = String(i).padStart(6, "0");
    // Every page links to the hub, so find_consumers on the hub returns n-1 relations.
    const related = i === 0 ? "[]" : "[[page-000000]]";
    // Half the pages carry provenance; the rest produce lint findings.
    const provenance =
      i % 2 === 0
        ? `canonical_source: "synthetic:corpus/page-${i}.md#L1"\nlast_verified_revision: "0000000000000000000000000000000000000000"`
        : `related_dangling: [[page-does-not-exist-${id}]]`;
    writeFileSync(
      join(knowledge, `page-${id}.md`),
      `---
type: concept
title: Page ${i}
source: synthetic
aliases: ["concept ${i}"]
${provenance}
related: ${related}
---

# Page ${i}

${body}
`,
    );
  }
  return { root, hubPath: "knowledge/page-000000.md" };
}

interface Row {
  pages: number;
  search: number;
  getPage: number;
  findConsumers: number;
  findCanonical: number;
  lint: number;
  lintFindings: number;
}

function measure(size: number): Row {
  const corpus = generate(size);
  try {
    const config: AccretaConfig = parseConfig(CONFIG_YAML);
    const indexPath = join(corpus.root, ".accreta", "index.sqlite");
    buildIndex({ root: corpus.root, config, indexPath });
    const db = openIndex(indexPath, { readonly: true });
    const ctx: ToolContext = {
      db,
      config,
      root: corpus.root,
      sources: new Map(),
      writesEnabled: false,
    };

    const lintResult = lintTool(ctx);
    const row: Row = {
      pages: size,
      search: serialize(searchPagesTool(ctx, { query: "forcing" })),
      getPage: serialize(getPageTool(ctx, { path: corpus.hubPath })),
      findConsumers: serialize(findConsumersTool(ctx, { target: corpus.hubPath })),
      findCanonical: serialize(findCanonicalTool(ctx, { term: "concept 1" })),
      lint: serialize(lintResult),
      lintFindings: lintResult.count,
    };
    db.close();
    return row;
  } finally {
    rmSync(corpus.root, { recursive: true, force: true });
  }
}

const kb = (bytes: number) =>
  bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)}MB` : `${(bytes / 1024).toFixed(1)}KB`;
const tok = (bytes: number) => {
  const t = estTokens(bytes);
  return t >= 1000 ? `${(t / 1000).toFixed(1)}k` : String(t);
};

console.log(`platform: ${process.platform} ${process.arch}, bun ${Bun.version}`);
console.log(`token estimate: bytes/4 (understates JSON; see the comment in this file)`);
console.log(`sizes: ${SIZES.join(", ")}\n`);

const rows: Row[] = [];
for (const size of SIZES) {
  process.stderr.write(`  measuring ${size} pages...\n`);
  rows.push(measure(size));
}

console.log("RESPONSE SIZE (bytes as serialized by the server)");
console.log("  pages   search    get_page  find_consumers  find_canonical      lint  findings");
for (const r of rows) {
  console.log(
    `  ${String(r.pages).padStart(5)}  ${kb(r.search).padStart(7)}  ${kb(r.getPage).padStart(10)}  ${kb(r.findConsumers).padStart(14)}  ${kb(r.findCanonical).padStart(14)}  ${kb(r.lint).padStart(8)}  ${String(r.lintFindings).padStart(8)}`,
  );
}

console.log("\nESTIMATED TOKENS");
console.log("  pages   search    get_page  find_consumers  find_canonical      lint");
for (const r of rows) {
  console.log(
    `  ${String(r.pages).padStart(5)}  ${tok(r.search).padStart(7)}  ${tok(r.getPage).padStart(10)}  ${tok(r.findConsumers).padStart(14)}  ${tok(r.findCanonical).padStart(14)}  ${tok(r.lint).padStart(8)}`,
  );
}

console.log("\nSHARE OF A 200k CONTEXT WINDOW (one call)");
console.log("  pages   search    get_page  find_consumers  find_canonical      lint");
const pct = (bytes: number) => `${((estTokens(bytes) / 200_000) * 100).toFixed(1)}%`;
for (const r of rows) {
  console.log(
    `  ${String(r.pages).padStart(5)}  ${pct(r.search).padStart(7)}  ${pct(r.getPage).padStart(10)}  ${pct(r.findConsumers).padStart(14)}  ${pct(r.findCanonical).padStart(14)}  ${pct(r.lint).padStart(8)}`,
  );
}

// Linear extrapolation from the largest measured size. Stated as extrapolation, not as
// measurement: the growth is linear in findings and the constant is what was measured.
const last = rows[rows.length - 1]!;
if (last.pages > 0) {
  console.log(`\nEXTRAPOLATION from ${last.pages} pages (linear; not measured)`);
  for (const target of [10_000, 100_000]) {
    const factor = target / last.pages;
    const lintTokens = estTokens(last.lint * factor);
    const consumersTokens = estTokens(last.findConsumers * factor);
    console.log(
      `  ${String(target).padStart(7)} pages: lint ~${(lintTokens / 1000).toFixed(0)}k tokens ` +
        `(${(lintTokens / 200_000).toFixed(0)}x a 200k window), ` +
        `find_consumers on the hub ~${(consumersTokens / 1000).toFixed(0)}k tokens`,
    );
  }
}
