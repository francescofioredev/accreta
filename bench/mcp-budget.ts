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
  if (!arg) return [10, 100, 1_000];
  const sizes = arg.slice("--sizes=".length).split(",").map(Number);
  // find_canonical probes "concept 1", which needs a second page.
  if (sizes.some((n) => !Number.isInteger(n) || n < 2)) throw new Error("--sizes: integers >= 2");
  return sizes;
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

const EMPTY_BODIES = new Set(["{}", "[]", '""', "null"]);

/** Exactly what the server sends: one text block of pretty-printed JSON. */
export function serialize(tool: string, value: unknown): number {
  // A Promise serializes to "{}", so an unawaited async tool would read as a 0KB response.
  if (typeof (value as { then?: unknown } | null)?.then === "function") {
    throw new Error(`${tool}: measured a pending Promise; await the tool`);
  }
  const text = JSON.stringify(value, null, 2);
  if (text === undefined || EMPTY_BODIES.has(text)) {
    throw new Error(`${tool}: serialized to an empty body (${String(text)})`);
  }
  return Buffer.byteLength(text, "utf-8");
}

/** A miss still serializes to a non-empty body, so the probe checks the content it measures. */
function expectProbe(tool: string, ok: boolean, detail: string): void {
  if (!ok) throw new Error(`${tool}: probe missed the corpus (${detail})`);
}

interface Corpus {
  root: string;
  hubPath: string;
  lintFindings: number;
}

/**
 * A corpus in the state a knowledge base is in when an agent most needs to lint it:
 * half the pages lack provenance and a verified revision, two lint findings each, which
 * is not pessimistic — it is what a half-finished ingest looks like.
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
  // Odd pages: missing-provenance and unverified-page. `related_dangling` is not a link field.
  return { root, hubPath: "knowledge/page-000000.md", lintFindings: 2 * Math.floor(n / 2) };
}

export interface Row {
  pages: number;
  search: number;
  getPage: number;
  findConsumers: number;
  findCanonical: number;
  lint: number;
  lintFindings: number;
}

export async function measure(size: number): Promise<Row> {
  const corpus = generate(size);
  try {
    const config: AccretaConfig = parseConfig(CONFIG_YAML);
    const indexPath = join(corpus.root, ".accreta", "index.sqlite");
    buildIndex({ root: corpus.root, config, indexPath });
    const db = openIndex(indexPath, { readonly: true });
    try {
      const ctx: ToolContext = {
        db,
        config,
        root: corpus.root,
        sources: new Map(),
        writesEnabled: false,
      };

      const search = searchPagesTool(ctx, { query: "forcing" });
      expectProbe("search_pages", search.count > 0, `count ${search.count}`);
      const page = getPageTool(ctx, { path: corpus.hubPath });
      expectProbe("get_page", page.found, `found ${page.found}`);
      const consumers = findConsumersTool(ctx, { target: corpus.hubPath });
      expectProbe(
        "find_consumers",
        consumers.target_exists && consumers.count === size - 1,
        `target_exists ${consumers.target_exists}, count ${consumers.count}, want ${size - 1}`,
      );
      const canonical = findCanonicalTool(ctx, { term: "concept 1" });
      expectProbe("find_canonical", canonical.count >= 1, `count ${canonical.count}`);
      const lintResult = await lintTool(ctx);
      expectProbe(
        "lint_knowledge_base",
        lintResult.count === corpus.lintFindings,
        `count ${lintResult.count}, want ${corpus.lintFindings}`,
      );

      return {
        pages: size,
        search: serialize("search_pages", search),
        getPage: serialize("get_page", page),
        findConsumers: serialize("find_consumers", consumers),
        findCanonical: serialize("find_canonical", canonical),
        lint: serialize("lint_knowledge_base", lintResult),
        lintFindings: lintResult.count,
      };
    } finally {
      // Close before rmSync deletes the directory the handle points into.
      db.close();
    }
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

async function main(): Promise<void> {
  console.log(`platform: ${process.platform} ${process.arch}, bun ${Bun.version}`);
  console.log(`token estimate: bytes/4 (understates JSON; see the comment in this file)`);
  console.log(`sizes: ${SIZES.join(", ")}\n`);

  const rows: Row[] = [];
  for (const size of SIZES) {
    process.stderr.write(`  measuring ${size} pages...\n`);
    rows.push(await measure(size));
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
}

if (import.meta.main) await main();
