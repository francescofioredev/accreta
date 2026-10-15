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
  type LocatorChange,
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
  /** The whole JSON-RPC response, serialized as the stdio transport sends it, minus its newline. */
  wire: number;
  text: string;
  value: any;
  structured?: any;
}

// Bytes of the last response each client's server sent: calls are sequential, so it is the call's.
const lastResponse = new WeakMap<Client, { bytes: number }>();

async function connect(ctx: ToolContext): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "mcp-budget", version: "0.0.0" });
  const response = { bytes: 0 };
  lastResponse.set(client, response);
  const send = serverTransport.send.bind(serverTransport);
  serverTransport.send = (message, options) => {
    if ("result" in message) response.bytes = Buffer.byteLength(JSON.stringify(message), "utf-8");
    return send(message, options);
  };
  await Promise.all([createServer(ctx).connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

async function call(client: Client, tool: string, args: Record<string, unknown>): Promise<Call> {
  const result = (await client.callTool({ name: tool, arguments: args })) as {
    content: { type: string; text?: string }[];
    structuredContent?: unknown;
    isError?: boolean;
  };
  const text = result.content.length === 1 ? result.content[0]?.text : undefined;
  if (result.isError) throw new Error(`${tool}: returned an error: ${text}`);
  const bytes = checkText(tool, text);
  const wire = lastResponse.get(client)!.bytes;
  return {
    bytes,
    wire,
    text: text!,
    value: JSON.parse(text!),
    structured: result.structuredContent,
  };
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
    // Plus one shared-alias finding for "shared concept".
    lintFindings: 2 * Math.floor(n / 2) + (n > 1 ? 1 : 0),
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
  /** search_pages' whole JSON-RPC response, its hits twice: text and structuredContent. */
  searchWire: number;
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
  /** get_page's JSON-RPC response minus every copy of the body in it. */
  getPageWireEnvelope: number;
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
        db
          .prepare("SELECT COUNT(*) AS n FROM pages_fts WHERE pages_fts MATCH ?")
          .get(aliasQuery) as {
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

      const body = page.value.page.body as string;
      const bodyJson = Buffer.byteLength(JSON.stringify(body), "utf-8");
      // The text copy is encoded twice on the wire: once into the text, once into the message.
      const bodyInText = Buffer.byteLength(JSON.stringify(JSON.stringify(body)), "utf-8") - 2;
      const bodyInStructured = page.structured?.page?.body === body ? bodyJson : 0;
      return {
        pages: size,
        search: search.bytes,
        searchWire: search.wire,
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
        getPageWireEnvelope: page.wire - bodyInText - bodyInStructured,
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

/** A source that answers from a script: every page is stale, and every changed path the same. */
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

/** Diffs contents as the git adapter does, so check_drift takes the branch git reports take. */
class ScriptedDiffingSource extends ScriptedSource {
  async touchedSince(
    _revision: string,
    _path: string,
    locators: readonly string[],
  ): Promise<Map<string, LocatorChange>> {
    return new Map(locators.map((l) => [l, LOCATOR_CHANGES[l] ?? { status: "unknown" }]));
  }
}

// One citation of each status check_drift reports differently: listed, listed with a move, counted.
const LOCATOR_CHANGES: Record<string, LocatorChange> = {
  L1: { status: "touched" },
  L2: { status: "moved", locator: "L20" },
  L3: { status: "untouched" },
};
const locatorOf = (i: number) => `L${1 + (i % 3)}`;

// Pages cite only the first few changed paths, so the citations do not grow with `changed`.
const CITED_PATHS = 10;

export const changedPath = (i: number) => `src/changed-${String(i).padStart(6, "0")}.txt`;

export interface DriftMode {
  /** The source diffs contents (touchedSince), as the git adapter does. */
  diffing: boolean;
  /** Stale revisions the pages are split across. */
  revisions: number;
  /** Citations into changed paths per page. */
  citesPerPage: 1 | 2;
  /** Odd pages below MIXED_PAGES, and all from it on, only cite this source; half by canonical_source too. */
  citedOnly?: boolean;
  /** Cited-only pages pin their second footnote at the next revision, so each sits in two groups. */
  pinnedTwice?: boolean;
}

// Pages past this are all cited-only, so the gate's extra pages measure cited-only pages alone.
export const MIXED_PAGES = 100;

export interface DriftRow {
  bytes: number;
  text: string;
  staleRevisions: number;
  /** Citations the report lists, by the path they cite. */
  listedCitations: Map<string, number>;
  /** Cited-only pages whose `cited_paths` entry names the path, by path. */
  citedPaths: Map<string, number>;
  /** The most stale groups any one page is listed in. */
  repetition: number;
}

/** The changed paths a cited-only page cites, as `cited_paths` should name them. */
type CitedPaths = Record<string, string[]>;

/** What one stale group should list, as the generator wrote it. */
interface WantGroup {
  pages: string[];
  citedOnly: string[];
  citedPaths: [string, string[]][];
}

// Order-free, so only what a group lists is compared, not the order it lists it in.
const normalized = (entries: [string, string[]][]) =>
  JSON.stringify(
    entries
      .map(([page, cited]) => [page, cited.toSorted()] as const)
      .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );

/** check_drift over `pages` pages after `changed` paths moved, each page citing into them. */
export async function measureDrift(
  pages: number,
  changed: number,
  mode: DriftMode,
): Promise<DriftRow> {
  if (mode.pinnedTwice && !(mode.citedOnly && mode.citesPerPage === 2 && mode.revisions >= 2)) {
    throw new Error("pinnedTwice: needs citedOnly, citesPerPage 2 and at least 2 revisions");
  }
  const root = mkdtempSync(join(tmpdir(), "accreta-mcp-drift-"));
  try {
    mkdirSync(join(root, "knowledge"), { recursive: true });
    writeFileSync(join(root, "accreta.config.yaml"), CONFIG_YAML);
    const wantGroups = new Map<string, WantGroup>();
    const wantGroup = (revision: string) => {
      const group = wantGroups.get(revision) ?? { pages: [], citedOnly: [], citedPaths: [] };
      wantGroups.set(revision, group);
      return group;
    };
    let wantCitations = 0;
    for (let i = 0; i < pages; i++) {
      const mixed = mode.citedOnly === true && i < MIXED_PAGES;
      // Ranked within its kind of page, so both kinds spread over every revision.
      const rank = mixed ? Math.floor(i / 2) : i;
      const revision = `rev-old-${rank % mode.revisions}`;
      const cite = `${changedPath(i % CITED_PATHS)}#${locatorOf(i)}`;
      const page = `knowledge/${pageId(i)}.md`;
      const ownPage = !mode.citedOnly || (mixed && i % 2 === 0);
      const secondPin =
        mode.pinnedTwice && !ownPage ? `rev-old-${(rank + 1) % mode.revisions}` : revision;
      const footnote =
        mode.citesPerPage === 2
          ? `\nA claim.[^a]\n\n[^a]: synthetic @ ${secondPin} · ${changedPath((i + 1) % CITED_PATHS)}#${locatorOf(i + 1)}\n`
          : "";
      const path = join(root, "knowledge", `${pageId(i)}.md`);
      if (ownPage) {
        wantCitations += mode.citesPerPage;
        wantGroup(revision).pages.push(page);
        writeFileSync(
          path,
          `---\ntype: concept\ntitle: Page ${i}\nsource: synthetic\ncanonical_source: "synthetic:${cite}"\nlast_verified_revision: ${revision}\n---\n\nPage ${i}.\n${footnote}`,
        );
        continue;
      }
      // canonical_source names no revision, so it borrows the pin of the footnote citing the same lines.
      const canonical =
        Math.floor(rank / 2) % 2 === 1 ? `canonical_source: "synthetic:${cite}"\n` : "";
      wantCitations += mode.citesPerPage + (canonical ? 1 : 0);
      // One entry per pin: a page pinned at two revisions is in both groups, each with its own paths.
      const pins = new Map<string, number[]>([[revision, [i % CITED_PATHS]]]);
      if (footnote) pins.set(secondPin, [...(pins.get(secondPin) ?? []), (i + 1) % CITED_PATHS]);
      for (const [pin, cited] of pins) {
        const hit = [...new Set(cited)].filter((n) => n < changed).map(changedPath);
        if (hit.length === 0) continue;
        const group = wantGroup(pin);
        group.pages.push(page);
        group.citedOnly.push(page);
        if (!mode.diffing) group.citedPaths.push([page, hit]);
      }
      writeFileSync(
        path,
        `---\ntype: concept\ntitle: Page ${i}\nsource: other\n${canonical}last_verified_revision: other-rev\n---\n\nPage ${i}.[^c]\n\n[^c]: synthetic @ ${revision} · ${cite}\n${footnote}`,
      );
    }
    const { config, db } = indexed(root);
    const paths = Array.from({ length: changed }, (_, i) => changedPath(i));
    const source = mode.diffing ? new ScriptedDiffingSource(paths) : new ScriptedSource(paths);
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
      const stale: {
        revision: string;
        pages: string[];
        cited_only?: string[];
        cited_paths?: CitedPaths;
        citations?: { path: string }[];
        citations_untouched?: number;
      }[] = drift.value.reports[0]?.stale ?? [];
      expectProbe(
        "check_drift",
        stale.length === wantGroups.size &&
          new Set(stale.map((s) => s.revision)).size === wantGroups.size,
        `${stale.length} stale revisions (${new Set(stale.map((s) => s.revision)).size} distinct), want ${wantGroups.size}`,
      );
      // Per group, so a page listed in a group it has no pin in fails, and so does a missing one.
      const sorted = (list: string[]) => JSON.stringify(list.toSorted());
      for (const s of stale) {
        const want = wantGroups.get(s.revision);
        expectProbe(
          "check_drift",
          want !== undefined &&
            sorted(s.pages) === sorted(want.pages) &&
            sorted(s.cited_only ?? []) === sorted(want.citedOnly),
          `${s.revision}: ${s.pages.length} pages, ${s.cited_only?.length ?? 0} cited-only, want ${want?.pages.length ?? 0} and ${want?.citedOnly.length ?? 0}`,
        );
        // Checked against the generator, so a path repeated inside cited_paths cannot set its own budget.
        const got = normalized(Object.entries(s.cited_paths ?? {}));
        const wantPaths = normalized(want!.citedPaths);
        expectProbe(
          "check_drift",
          got === wantPaths,
          `${s.revision}: cited_paths ${got.slice(0, 200)}, want ${wantPaths.slice(0, 200)}`,
        );
      }
      const citations = stale.reduce(
        (n, s) => n + (s.citations?.length ?? 0) + (s.citations_untouched ?? 0),
        0,
      );
      expectProbe(
        "check_drift",
        citations === (mode.diffing ? wantCitations : 0),
        `${citations} citations, want ${mode.diffing ? wantCitations : 0}`,
      );
      const citedPaths = stale.flatMap((s) => Object.entries(s.cited_paths ?? {}));
      const groupsOf = new Map<string, number>();
      for (const page of stale.flatMap((s) => s.pages)) {
        groupsOf.set(page, (groupsOf.get(page) ?? 0) + 1);
      }
      const listedCitations = new Map<string, number>();
      for (const c of stale.flatMap((s) => s.citations ?? [])) {
        listedCitations.set(c.path, (listedCitations.get(c.path) ?? 0) + 1);
      }
      const citedPathCounts = new Map<string, number>();
      for (const path of citedPaths.flatMap(([, cited]) => cited)) {
        citedPathCounts.set(path, (citedPathCounts.get(path) ?? 0) + 1);
      }
      return {
        bytes: drift.bytes,
        text: drift.text,
        staleRevisions: stale.length,
        listedCitations,
        citedPaths: citedPathCounts,
        repetition: Math.max(0, ...groupsOf.values()),
      };
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
  console.log("\nCHECK_DRIFT (all pages stale against one revision, one citation each)");
  console.log("  pages  changed  source diffs  response  share of 200k");
  for (const [pages, changed, diffing] of [
    [100, 10, false],
    [1_000, 10, false],
    [1_000, 100, false],
    [100, 10, true],
    [1_000, 10, true],
    [1_000, 100, true],
  ] as const) {
    const d = await measureDrift(pages, changed, { diffing, revisions: 1, citesPerPage: 1 });
    console.log(
      `  ${String(pages).padStart(5)}  ${String(changed).padStart(7)}  ${String(diffing).padStart(12)}  ${kb(d.bytes).padStart(8)}  ${pct(d.bytes).padStart(12)}`,
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
