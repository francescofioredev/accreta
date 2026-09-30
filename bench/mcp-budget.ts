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
 * Every call goes through the server over an in-memory MCP transport, and what is measured
 * is the text block it returns, so a change to the server's handlers or serialisation counts.
 */
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildIndex,
  openIndex,
  parseConfig,
  parsePage,
  type AccretaConfig,
  type LocationVerdict,
  type SourceAdapter,
} from "@accreta/core";
import { createServer, type ToolContext } from "@accreta/mcp-server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const PROBE_WORD = "forcing";
const sentence = (i: number) =>
  `Sentence ${i} about radiative ${PROBE_WORD}, feedback strength and carbon budget.`;
// The shortest body that still holds the word search_pages probes for.
const MIN_BODY_BYTES = sentence(0).indexOf(PROBE_WORD) + PROBE_WORD.length;

function checkBodyBytes(bytes: number): void {
  if (bytes < MIN_BODY_BYTES) {
    throw new Error(
      `--body-bytes: at least ${MIN_BODY_BYTES}, so the body keeps "${PROBE_WORD}", which search_pages probes for`,
    );
  }
}

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
  if (!Number.isInteger(bytes)) throw new Error("--body-bytes: an integer");
  checkBodyBytes(bytes);
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

/** Bytes of the text a tool returned, refusing a body that cannot be what was asked for. */
export function checkText(tool: string, text: string | undefined): number {
  if (text === undefined || EMPTY_BODIES.has(text)) {
    // A handler returning an unawaited Promise serializes it to "{}".
    throw new Error(
      `${tool}: returned an empty body (${String(text)}); was a Promise not awaited?`,
    );
  }
  return Buffer.byteLength(text, "utf-8");
}

/** A miss still returns a non-empty body, so the probe checks the content it measures. */
function expectProbe(tool: string, ok: boolean, detail: string): void {
  if (!ok) throw new Error(`${tool}: probe missed the corpus (${detail})`);
}

interface Call {
  bytes: number;
  text: string;
  value: any;
}

async function connect(ctx: ToolContext): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "mcp-budget", version: "0.0.0" });
  await Promise.all([createServer(ctx).connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

async function call(client: Client, tool: string, args: Record<string, unknown>): Promise<Call> {
  const result = (await client.callTool({ name: tool, arguments: args })) as {
    content: { type: string; text?: string }[];
    isError?: boolean;
  };
  const text = result.content.length === 1 ? result.content[0]?.text : undefined;
  if (result.isError) throw new Error(`${tool}: returned an error: ${text}`);
  const bytes = checkText(tool, text);
  return { bytes, text: text!, value: JSON.parse(text!) };
}

// Pages 2..31 link to the mixed page, and it links to 32 onwards: inbound and outbound share a page.
const MIXED_INBOUND_LAST = 31;

interface Corpus {
  root: string;
  hubPath: string;
  mixedPath: string;
  sharedAlias: string;
  lintFindings: number;
  bodyBytes: number;
}

const pageId = (i: number) => `page-${String(i).padStart(6, "0")}`;

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
    checkBodyBytes(bodyBytes);
    for (let i = 400; body.length < bodyBytes; i++) body += ` ${sentence(i)}`;
    // ASCII, so one character is one byte.
    body = body.slice(0, bodyBytes);
  }

  for (let i = 0; i < n; i++) {
    // Every page links to the hub, so find_consumers on the hub returns n-1 relations.
    const links = i === 0 ? [] : [pageId(0)];
    if (i >= 2 && i <= MIXED_INBOUND_LAST) links.push(pageId(1));
    if (i === 1) for (let j = MIXED_INBOUND_LAST + 1; j < n; j++) links.push(pageId(j));
    const related = links.length === 0 ? "[]" : links.map((l) => `[[${l}]]`).join(", ");
    // Half the pages carry provenance; the rest produce lint findings.
    const provenance =
      i % 2 === 0
        ? `canonical_source: "synthetic:corpus/page-${i}.md#L1"\nlast_verified_revision: "0000000000000000000000000000000000000000"`
        : `related_dangling: [[page-does-not-exist-${String(i).padStart(6, "0")}]]`;
    writeFileSync(
      join(knowledge, `${pageId(i)}.md`),
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
    hubPath: `knowledge/${pageId(0)}.md`,
    mixedPath: `knowledge/${pageId(1)}.md`,
    // On every page, so find_canonical has n matches: an upper bound, like the hub.
    sharedAlias: "shared concept",
    lintFindings: 2 * Math.floor(n / 2),
    bodyBytes: Buffer.byteLength(body, "utf-8"),
  };
}

function indexed(root: string): { config: AccretaConfig; db: ReturnType<typeof openIndex> } {
  const config = parseConfig(CONFIG_YAML);
  const indexPath = join(root, ".accreta", "index.sqlite");
  buildIndex({ root, config, indexPath });
  return { config, db: openIndex(indexPath, { readonly: true }) };
}

export interface Row {
  pages: number;
  search: number;
  /** search_pages on the shared alias, so every hit carries `matched_aliases`. */
  searchAliased: number;
  /** Pages the aliased probe matches in the index, before search_pages' limit. */
  searchAliasedMatches: number;
  getPage: number;
  /** The generated prose in every page, which get_page's figure is made of. */
  bodyBytes: number;
  findConsumers: number;
  /** find_consumers on a page whose default response holds inbound and outbound relations. */
  findConsumersMixed: number;
  /** Outbound relations of the mixed page: in its default response, and in all. */
  mixedOutbound: { returned: number; count: number };
  findCanonical: number;
  lint: number;
  lintFindings: number;
  /** get_page minus its JSON-encoded body: the part accreta decides. */
  getPageEnvelope: number;
  /** Entries each list tool returned, and its `count`; fewer returned means one page. */
  entries: Record<ListTool, { returned: number; count: number }>;
}

export type ListTool =
  "search" | "searchAliased" | "findConsumers" | "findConsumersMixed" | "findCanonical" | "lint";

const entries = (c: Call, list: string) => ({
  returned: c.value[list].length as number,
  count: c.value.count as number,
});
const outbound = (results: { direction: string }[]) =>
  results.filter((r) => r.direction === "outbound").length;

export async function measure(size: number, options: { bodyBytes?: number } = {}): Promise<Row> {
  const corpus = generate(size, options.bodyBytes);
  try {
    const { config, db } = indexed(corpus.root);
    const ctx: ToolContext = {
      db,
      config,
      root: corpus.root,
      sources: new Map(),
      unloadedSources: [],
      writesEnabled: false,
    };
    const client = await connect(ctx);
    try {
      const search = await call(client, "search_pages", { query: PROBE_WORD });
      expectProbe("search_pages", search.value.count > 0, `count ${search.value.count}`);
      const aliasQuery = `"${corpus.sharedAlias}"`;
      const aliased = await call(client, "search_pages", { query: aliasQuery });
      const searchAliasedMatches = (
        db.query("SELECT COUNT(*) AS n FROM pages_fts WHERE pages_fts MATCH ?").get(aliasQuery) as {
          n: number;
        }
      ).n;
      expectProbe(
        "search_pages",
        aliased.value.results.every((r: { matched_aliases?: string[] }) =>
          r.matched_aliases?.includes(corpus.sharedAlias),
        ),
        "a hit without the shared alias in matched_aliases",
      );

      const page = await call(client, "get_page", { path: corpus.hubPath });
      expectProbe("get_page", page.value.found, `found ${page.value.found}`);

      const consumers = await call(client, "find_consumers", { target: corpus.hubPath });
      expectProbe(
        "find_consumers",
        consumers.value.target_exists && consumers.value.count === size - 1,
        `target_exists ${consumers.value.target_exists}, count ${consumers.value.count}, want ${size - 1}`,
      );
      const mixed = await call(client, "find_consumers", { target: corpus.mixedPath });
      const mixedOutboundCount = size > 1 ? 1 + Math.max(0, size - MIXED_INBOUND_LAST - 1) : 0;
      const mixedInboundCount = Math.max(0, Math.min(size - 1, MIXED_INBOUND_LAST) - 1);
      expectProbe(
        "find_consumers",
        mixed.value.count === mixedInboundCount + mixedOutboundCount,
        `count ${mixed.value.count}, want ${mixedInboundCount + mixedOutboundCount}`,
      );

      const canonical = await call(client, "find_canonical", { term: corpus.sharedAlias });
      expectProbe(
        "find_canonical",
        canonical.value.count === size,
        `count ${canonical.value.count}, want ${size}`,
      );
      const lint = await call(client, "lint_knowledge_base", {});
      expectProbe(
        "lint_knowledge_base",
        lint.value.count === corpus.lintFindings,
        `count ${lint.value.count}, want ${corpus.lintFindings}`,
      );

      const bodyJson = Buffer.byteLength(JSON.stringify(page.value.page.body), "utf-8");
      return {
        pages: size,
        search: search.bytes,
        searchAliased: aliased.bytes,
        searchAliasedMatches,
        getPage: page.bytes,
        bodyBytes: corpus.bodyBytes,
        findConsumers: consumers.bytes,
        findConsumersMixed: mixed.bytes,
        mixedOutbound: { returned: outbound(mixed.value.results), count: mixedOutboundCount },
        findCanonical: canonical.bytes,
        lint: lint.bytes,
        lintFindings: lint.value.count,
        getPageEnvelope: page.bytes - bodyJson,
        entries: {
          search: entries(search, "results"),
          searchAliased: entries(aliased, "results"),
          findConsumers: entries(consumers, "results"),
          findConsumersMixed: entries(mixed, "results"),
          findCanonical: entries(canonical, "results"),
          lint: entries(lint, "findings"),
        },
      };
    } finally {
      await client.close();
      // Close before rmSync deletes the directory the handle points into.
      db.close();
    }
  } finally {
    rmSync(corpus.root, { recursive: true, force: true });
  }
}

/** A source that answers from a script: every page is stale against one revision. */
class ScriptedSource implements SourceAdapter {
  readonly id = "synthetic";
  constructor(private readonly changed: string[]) {}
  async revision(): Promise<string> {
    return "rev-now";
  }
  async changedSince(): Promise<string[]> {
    return this.changed;
  }
  async locate(): Promise<LocationVerdict> {
    return { verdict: "found" };
  }
  citation(path: string, locator?: string): string {
    return locator ? `${this.id}:${path}#${locator}` : `${this.id}:${path}`;
  }
  pinRevision(): void {}
}

export const changedPath = (i: number) => `src/changed-${String(i).padStart(6, "0")}.txt`;

export interface DriftRow {
  pages: number;
  changed: number;
  bytes: number;
  text: string;
}

/**
 * check_drift over `pages` pages verified at one revision, after `changed` paths moved.
 * Every page sharing one revision is what a git ingest produces by construction (ADR-0007).
 */
export async function measureDrift(pages: number, changed: number): Promise<DriftRow> {
  const root = mkdtempSync(join(tmpdir(), "accreta-mcp-drift-"));
  try {
    mkdirSync(join(root, "knowledge"), { recursive: true });
    writeFileSync(join(root, "accreta.config.yaml"), CONFIG_YAML);
    for (let i = 0; i < pages; i++) {
      writeFileSync(
        join(root, "knowledge", `${pageId(i)}.md`),
        `---\ntype: concept\ntitle: Page ${i}\nsource: synthetic\nlast_verified_revision: rev-old\n---\n\nPage ${i}.\n`,
      );
    }
    const { config, db } = indexed(root);
    const source = new ScriptedSource(Array.from({ length: changed }, (_, i) => changedPath(i)));
    const ctx: ToolContext = {
      db,
      config,
      root,
      sources: new Map([[source.id, source]]),
      unloadedSources: [],
      writesEnabled: false,
    };
    const client = await connect(ctx);
    try {
      const drift = await call(client, "check_drift", {});
      const stale = drift.value.reports[0]?.stale ?? [];
      expectProbe(
        "check_drift",
        stale.length === 1 && stale[0].pages.length === pages,
        `${stale.length} stale revisions, want 1 with ${pages} pages`,
      );
      return { pages, changed, bytes: drift.bytes, text: drift.text };
    } finally {
      await client.close();
      db.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const kb = (bytes: number) =>
  bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)}MB` : `${(bytes / 1024).toFixed(1)}KB`;
const tok = (bytes: number) => {
  const t = estTokens(bytes);
  return t >= 1000 ? `${(t / 1000).toFixed(1)}k` : String(t);
};
const pct = (bytes: number) => `${((estTokens(bytes) / 200_000) * 100).toFixed(1)}%`;

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

  console.log("RESPONSE SIZE (bytes of the text block the server returns)");
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
  for (const r of rows) {
    console.log(
      `  ${String(r.pages).padStart(5)}  ${pct(r.search).padStart(7)}  ${pct(r.getPage).padStart(10)}  ${pct(r.findConsumers).padStart(14)}  ${pct(r.findCanonical).padStart(14)}  ${pct(r.lint).padStart(8)}`,
    );
  }

  // ADR-0007's drift table: every page verified at one revision, as a git ingest leaves them.
  console.log("\nCHECK_DRIFT (all pages stale against one revision)");
  console.log("  pages  changed  response  share of 200k");
  for (const [pages, changed] of [
    [100, 10],
    [1_000, 10],
    [1_000, 100],
  ] as const) {
    const d = await measureDrift(pages, changed);
    console.log(
      `  ${String(pages).padStart(5)}  ${String(changed).padStart(7)}  ${kb(d.bytes).padStart(8)}  ${pct(d.bytes).padStart(12)}`,
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
