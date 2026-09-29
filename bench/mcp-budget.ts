#!/usr/bin/env bun
/**
 * Measure what each MCP tool costs the agent that calls it.
 *
 * The consumer of this server is a language model with a finite context window, so every
 * token a tool returns is a token unavailable for reasoning. `search_pages` returns at
 * most 50 results, and `find_consumers`, `find_canonical` and `lint_knowledge_base` one
 * page of at most 50 (ADR-0007). `get_page` returns a whole body, and `check_drift`
 * everything it finds. Whether that matters is not a matter of opinion; it is a number,
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
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildIndex, openIndex, parseConfig, parsePage, type AccretaConfig } from "@accreta/core";
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
  if (sizes.some((n) => !Number.isInteger(n) || n < 1)) throw new Error("--sizes: integers >= 1");
  return sizes;
})();

// Undefined keeps the 400-sentence body ADR-0007's table was measured with.
const BODY_BYTES = ((): number | undefined => {
  const arg = process.argv.find((a) => a.startsWith("--body-bytes="));
  if (!arg) return undefined;
  const bytes = Number(arg.slice("--body-bytes=".length));
  if (!Number.isInteger(bytes) || bytes < 1) throw new Error("--body-bytes: an integer >= 1");
  return bytes;
})();

const DEMO_KB = join(import.meta.dir, "..", "examples", "climate", "knowledge");

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
  sharedAlias: string;
  lintFindings: number;
  bodyBytes: number;
}

const sentence = (i: number) =>
  `Sentence ${i} about radiative forcing, feedback strength and carbon budget.`;

/**
 * A corpus in the state a knowledge base is in when an agent most needs to lint it:
 * half the pages lack provenance and a verified revision, two lint findings each, which
 * is not pessimistic — it is what a half-finished ingest looks like.
 */
function generate(n: number, bodyBytes?: number): Corpus {
  const root = mkdtempSync(join(tmpdir(), "accreta-mcp-budget-"));
  const knowledge = join(root, "knowledge");
  mkdirSync(knowledge, { recursive: true });
  writeFileSync(join(root, "accreta.config.yaml"), CONFIG_YAML);

  let body = Array.from({ length: 400 }, (_, i) => sentence(i)).join(" ");
  if (bodyBytes !== undefined) {
    for (let i = 400; body.length < bodyBytes; i++) body += ` ${sentence(i)}`;
    // ASCII, so one character is one byte.
    body = body.slice(0, bodyBytes);
  }

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
aliases: ["concept ${i}", "shared concept"]
${provenance}
related: ${related}
---

# Page ${i}

${body}
`,
    );
  }
  // Odd pages: missing-provenance and unverified-page. `related_dangling` is not a link field.
  return {
    root,
    hubPath: "knowledge/page-000000.md",
    // On every page, so find_canonical has n matches: an upper bound, like the hub.
    sharedAlias: "shared concept",
    lintFindings: 2 * Math.floor(n / 2),
    bodyBytes: Buffer.byteLength(body, "utf-8"),
  };
}

export interface Row {
  pages: number;
  search: number;
  getPage: number;
  /** The generated prose in every page, which get_page's figure is made of. */
  bodyBytes: number;
  findConsumers: number;
  findCanonical: number;
  lint: number;
  lintFindings: number;
  /** get_page minus its JSON-encoded body: the part accreta decides. */
  getPageEnvelope: number;
  /** Entries each list tool returned, and its `count`; fewer returned means one page. */
  entries: Record<ListTool, { returned: number; count: number }>;
}

export type ListTool = "search" | "findConsumers" | "findCanonical" | "lint";

export async function measure(size: number, options: { bodyBytes?: number } = {}): Promise<Row> {
  const corpus = generate(size, options.bodyBytes);
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
        unloadedSources: [],
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
      const canonical = findCanonicalTool(ctx, { term: corpus.sharedAlias });
      expectProbe(
        "find_canonical",
        canonical.count === size,
        `count ${canonical.count}, want ${size}`,
      );
      const lintResult = await lintTool(ctx);
      expectProbe(
        "lint_knowledge_base",
        lintResult.count === corpus.lintFindings,
        `count ${lintResult.count}, want ${corpus.lintFindings}`,
      );

      const getPage = serialize("get_page", page);
      const bodyJson = page.found ? Buffer.byteLength(JSON.stringify(page.page.body), "utf-8") : 0;
      return {
        pages: size,
        search: serialize("search_pages", search),
        getPage,
        bodyBytes: corpus.bodyBytes,
        findConsumers: serialize("find_consumers", consumers),
        findCanonical: serialize("find_canonical", canonical),
        lint: serialize("lint_knowledge_base", lintResult),
        lintFindings: lintResult.count,
        getPageEnvelope: getPage - bodyJson,
        entries: {
          search: { returned: search.results.length, count: search.count },
          findConsumers: { returned: consumers.results.length, count: consumers.count },
          findCanonical: { returned: canonical.results.length, count: canonical.count },
          lint: { returned: lintResult.findings.length, count: lintResult.count },
        },
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

/** Body bytes of the demo pages, parsed as the indexer parses them, for scale. */
function demoBodyRange(): string {
  const sizes = readdirSync(DEMO_KB, { recursive: true })
    .map(String)
    .filter((f) => f.endsWith(".md"))
    .map((f) => Buffer.byteLength(parsePage(readFileSync(join(DEMO_KB, f), "utf-8"), f).body));
  if (sizes.length === 0) return "no demo pages to compare with";
  return `real page bodies in examples/climate run ${grouped(Math.min(...sizes))}-${grouped(Math.max(...sizes))}`;
}

const grouped = (x: number) => x.toLocaleString("en-US");

async function main(): Promise<void> {
  console.log(`platform: ${process.platform} ${process.arch}, bun ${Bun.version}`);
  console.log(`token estimate: bytes/4 (understates JSON; see the comment in this file)`);
  console.log(`sizes: ${SIZES.join(", ")}`);

  const rows: Row[] = [];
  for (const size of SIZES) {
    process.stderr.write(`  measuring ${size} pages...\n`);
    rows.push(await measure(size, { bodyBytes: BODY_BYTES }));
  }

  const body = grouped(rows[0]!.bodyBytes);
  console.log(`body size: ${body} bytes (generated; ${demoBodyRange()}; set with --body-bytes=N)`);
  console.log("  get_page is that body plus a fixed envelope: its figure describes the generator.");
  console.log("  find_consumers probes the hub of a star graph, so its figure is an upper bound.");
  console.log("  find_canonical probes an alias every page shares: an upper bound too.\n");

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
  // A paged response stays one page however large `count` grows, so it is not extrapolated.
  const last = rows[rows.length - 1]!;
  const paged = (tool: ListTool) => last.entries[tool].count > last.entries[tool].returned;
  const growing = [
    { name: "lint", bytes: last.lint, paged: paged("lint") },
    { name: "find_consumers on the hub", bytes: last.findConsumers, paged: paged("findConsumers") },
    {
      name: "find_canonical on the shared alias",
      bytes: last.findCanonical,
      paged: paged("findCanonical"),
    },
  ];
  if (last.pages > 0) {
    console.log(`\nEXTRAPOLATION from ${last.pages} pages (linear; not measured)`);
    for (const tool of growing) {
      if (tool.paged) {
        console.log(`  ${tool.name}: paged at ${last.pages} pages, so bounded; not extrapolated`);
        continue;
      }
      for (const target of [10_000, 100_000]) {
        const tokens = estTokens(tool.bytes * (target / last.pages));
        console.log(
          `  ${tool.name}, ${String(target).padStart(7)} pages: ~${(tokens / 1000).toFixed(0)}k tokens ` +
            `(${(tokens / 200_000).toFixed(0)}x a 200k window)`,
        );
      }
    }
  }
}

if (import.meta.main) await main();
