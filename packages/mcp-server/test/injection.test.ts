import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildIndex, parseConfig, type SourceAdapter } from "@accreta/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createContext, createServer, type ToolContext } from "../src/index.ts";

const FIXTURE = join(import.meta.dir, "fixtures", "injected-kb");

// Every author-written string in the fixture carries one of these, so any response field it lands in is found.
const CANARY = /CANARY-([A-Z]+)/g;

// The channels #139 names; the rest of the fixture's canaries widen the net.
const REQUIRED_CHANNELS = ["BODY", "TITLE", "ALIAS", "FIELD"];

/** Arguments that make each tool surface the injected pages. None contains a canary, so nothing found is an echo. */
const PROBES: Record<string, Record<string, unknown>[]> = {
  search_pages: [{ query: "canary" }, { query: "forcing" }, { query: "hostile" }],
  get_page: [{ path: "concepts/injected" }, { path: "notes/foreign-source" }],
  find_consumers: [
    { target: "notes/neighbour", include_inline: true },
    { target: "concepts/injected", include_inline: true },
  ],
  find_canonical: [{ term: "concepts/injected" }, { term: "radiative forcing" }],
  check_drift: [{}],
  list_recent_changes: [{ source: "docs", since: "0" }],
  lint_knowledge_base: [{}],
  update_verified_revision: [{ path: "concepts/injected", revision: "deadbeef" }],
};

// Page-derived text unmarked today, as "tool path". The fix belongs in src/tools.ts; delete entries as it lands.
const KNOWN_UNMARKED: string[] = [
  "check_drift reports[].stale[].citations[].footnote",
  "check_drift reports[].stale[].citations[].locator",
  "check_drift reports[].unresolvable[].revision",
  "find_canonical results[].canonical_source",
  "find_canonical results[].type",
  "find_consumers results[].type",
  "get_page page.canonical_source",
  "get_page page.last_verified_revision",
  "get_page page.source",
  "get_page page.type",
  "search_pages results[].last_verified_revision",
  "search_pages results[].source",
  "search_pages results[].type",
  "update_verified_revision current_revision",
];

// check_drift reports per citation only for a source that diffs contents, and the fixture's fs source does not.
const DIFFING_SOURCE: SourceAdapter = {
  id: "lines",
  revision: async () => "rev2",
  changedSince: async () => ["ch.md"],
  locate: async () => ({ verdict: "found" }),
  citation: () => "",
  pinRevision: () => {},
  touchedSince: async (_revision, _path, locators) =>
    new Map(locators.map((locator) => [locator, { status: "touched" as const }])),
};

function canariesIn(text: string): string[] {
  return [...new Set([...text.matchAll(CANARY)].map((m) => m[1] ?? ""))];
}

let root = "";

function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

// Through createContext, so the gate under test is the env var itself rather than a flag set by hand.
function contextWith(allowWrites: string | undefined): ToolContext {
  return withEnv(
    { ACCRETA_ALLOW_WRITES: allowWrites, ACCRETA_ROOT: undefined, ACCRETA_INDEX_PATH: undefined },
    () => createContext(root),
  );
}

async function connect(ctx: ToolContext): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "injection-probe", version: "0.0.0" });
  await Promise.all([createServer(ctx).connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

/** Every string in a value, keys included, with its path in `_provenance` notation (`results[].title`). */
function* strings(value: unknown, path = ""): Generator<[string, string]> {
  if (typeof value === "string") {
    yield [path, value];
  } else if (Array.isArray(value)) {
    for (const item of value) yield* strings(item, `${path}[]`);
  } else if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      const childPath = path ? `${path}.${key}` : key;
      yield [childPath, key];
      yield* strings(child, childPath);
    }
  }
}

function covers(field: string, path: string): boolean {
  return path === field || path.startsWith(`${field}.`) || path.startsWith(`${field}[]`);
}

interface Leak {
  path: string;
  channel: string;
}

/** Canary-bearing strings in one response, split by whether `_provenance` names their field. */
function audit(payload: unknown): { marked: Leak[]; unmarked: Leak[] } {
  const record = (payload ?? {}) as { _provenance?: { page_derived_fields?: unknown } };
  const declared = record._provenance?.page_derived_fields;
  const fields = Array.isArray(declared) ? declared.filter((f) => typeof f === "string") : [];
  const marked: Leak[] = [];
  const unmarked: Leak[] = [];
  for (const [path, text] of strings(payload)) {
    if (path === "_provenance" || path.startsWith("_provenance.")) continue;
    const bucket = fields.some((f) => covers(f, path)) ? marked : unmarked;
    // Search snippets wrap each matched term in << >>, splitting the canary.
    for (const channel of canariesIn(text.replaceAll("<<", "").replaceAll(">>", ""))) {
      bucket.push({ path, channel });
    }
  }
  return { marked, unmarked };
}

/** A tool result's text, parsed; a non-JSON text is audited as one unnamed field. */
function payloadsOf(result: unknown): unknown[] {
  const content = (result as { content?: { type: string; text?: string }[] }).content ?? [];
  return content
    .filter((c) => c.type === "text" && typeof c.text === "string")
    .map((c) => {
      try {
        return JSON.parse(c.text ?? "") as unknown;
      } catch {
        return { "<text>": c.text };
      }
    });
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "accreta-injection-"));
  cpSync(FIXTURE, root, { recursive: true });
  const config = parseConfig(readFileSync(join(root, "accreta.config.yaml"), "utf-8"));
  buildIndex({ root, config, indexPath: join(root, ".accreta", "index.sqlite") });
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("every tool response, against a page that tries to give instructions", () => {
  const unmarked = new Set<string>();
  const seen = new Set<string>();
  const tools: string[] = [];

  beforeAll(async () => {
    // Writes on, so the write tool is enumerated and swept like the rest.
    const ctx = contextWith("1");
    ctx.sources.set("lines", DIFFING_SOURCE);
    const client = await connect(ctx);
    try {
      const listed = await client.listTools();
      for (const tool of listed.tools) {
        tools.push(tool.name);
        for (const args of PROBES[tool.name] ?? []) {
          const result = await client.callTool({ name: tool.name, arguments: args });
          for (const payload of payloadsOf(result)) {
            const { marked, unmarked: leaks } = audit(payload);
            for (const leak of [...marked, ...leaks]) seen.add(leak.channel);
            for (const leak of leaks) unmarked.add(`${tool.name} ${leak.path}`);
          }
        }
      }
    } finally {
      await client.close();
      ctx.db.close();
    }
  });

  test("every registered tool has a probe", () => {
    // A new tool without one would be swept with nothing and pass by default.
    expect(tools.filter((name) => !(name in PROBES))).toEqual([]);
  });

  test("every canary in the fixture reaches some response, including the channels #139 names", () => {
    // A canary nothing surfaces means a probe went blind, and the sweep above would pass by default.
    const planted = readdirSync(FIXTURE, { recursive: true, encoding: "utf-8" })
      .filter((name) => name.endsWith(".md"))
      .flatMap((name) => canariesIn(readFileSync(join(FIXTURE, name), "utf-8")));
    expect(planted).toEqual(expect.arrayContaining(REQUIRED_CHANNELS));
    expect([...new Set(planted)].filter((channel) => !seen.has(channel))).toEqual([]);
  });

  test("no page-derived string reaches the model outside a field _provenance names", () => {
    expect([...unmarked].filter((leak) => !KNOWN_UNMARKED.includes(leak)).toSorted()).toEqual([]);
  });

  test("every known gap is still a gap", () => {
    // Fails once a gap is marked, so the list shrinks rather than going stale.
    expect(KNOWN_UNMARKED.filter((leak) => !unmarked.has(leak))).toEqual([]);
  });
});

describe("the audit itself", () => {
  test("flags a canary in a field the response does not name", () => {
    const payload = {
      results: [{ title: "CANARY-TITLE x", summary: "CANARY-BODY y", path: "a.md" }],
      _provenance: { page_derived_fields: ["results[].title"] },
    };
    expect(audit(payload).unmarked).toEqual([{ path: "results[].summary", channel: "BODY" }]);
  });

  test("a named field covers what is nested under it, keys included", () => {
    const payload = {
      page: { frontmatter: { "CANARY-KEY k": "CANARY-FIELD v", nested: ["CANARY-ALIAS a"] } },
      _provenance: { page_derived_fields: ["page.frontmatter"] },
    };
    const { marked, unmarked } = audit(payload);
    expect(unmarked).toEqual([]);
    expect(marked.map((leak) => leak.channel).toSorted()).toEqual(["ALIAS", "FIELD", "KEY"]);
  });

  test("a response with no _provenance block marks nothing", () => {
    expect(audit({ reports: [{ revision: "CANARY-REVISION r" }] }).unmarked).toEqual([
      { path: "reports[].revision", channel: "REVISION" },
    ]);
  });

  test("a prefix match is on a field boundary, not a substring", () => {
    const payload = {
      results: [{ title_extra: "CANARY-TITLE x" }],
      _provenance: { page_derived_fields: ["results[].title"] },
    };
    expect(audit(payload).unmarked).toHaveLength(1);
  });
});

describe("the write tool", () => {
  test.each([[undefined], ["0"], [""]])(
    "is not registered when ACCRETA_ALLOW_WRITES is %p",
    async (value) => {
      const ctx = contextWith(value);
      const client = await connect(ctx);
      try {
        const names = (await client.listTools()).tools.map((tool) => tool.name);
        expect(names).not.toContain("update_verified_revision");
        expect(names).toContain("get_page");
      } finally {
        await client.close();
        ctx.db.close();
      }
    },
  );

  test("is registered when ACCRETA_ALLOW_WRITES=1, so the gate above is not vacuous", async () => {
    const ctx = contextWith("1");
    const client = await connect(ctx);
    try {
      const names = (await client.listTools()).tools.map((tool) => tool.name);
      expect(names).toContain("update_verified_revision");
    } finally {
      await client.close();
      ctx.db.close();
    }
  });
});
