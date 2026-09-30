import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { buildIndex, DelegatedSourceError, parseConfig, type SourceAdapter } from "@accreta/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createContext, createServer, type ToolContext } from "../src/index.ts";

const FIXTURE = join(import.meta.dir, "fixtures", "injected-kb");

// Every author-written string in the fixture carries one of these, so any response field it lands in is found.
// Tags lead each string and close each body, which survives truncation and case changes; hashing, encoding
// (base64 and the like) or cutting a value before its tag cannot be caught.
const CANARY = /canary-([a-z]+)/gi;

// The channels #139 names; the rest of the fixture's canaries widen the net.
const REQUIRED_CHANNELS = ["BODY", "TITLE", "ALIAS", "FIELD"];

const WRITE_TOOL = "update_verified_revision";

type Probe = Record<string, unknown> | ((previous: unknown) => Record<string, unknown>);

/** Arguments that make each tool surface the injected pages. None contains a canary, so nothing found is an echo. */
const PROBES: Record<string, Probe[]> = {
  search_pages: [{ query: "canary" }, { query: "forcing" }, { query: "hostile" }],
  get_page: [{ path: "concepts/injected" }, { path: "notes/foreign-source" }],
  find_consumers: [
    { target: "notes/neighbour", include_inline: true },
    { target: "concepts/injected", include_inline: true },
  ],
  find_canonical: [{ term: "concepts/injected" }, { term: "filename probe" }],
  check_drift: [{}],
  list_recent_changes: [
    { source: "docs", since: "0" },
    { source: "lines", since: "rev1" },
  ],
  lint_knowledge_base: [{}],
  cite: [
    { target: "docs:ch01.md#L1" },
    { target: "docs:ch01.md#L999" },
    { target: "quoting:p#b1" },
  ],
  [WRITE_TOOL]: [
    // Refused: the page's own source is page text, echoed back.
    { path: "notes/foreign-source", source: "docs", revision: "deadbeef" },
    { path: "concepts/injected", source: "docs", revision: "deadbeef" },
    (dryRun) => ({
      path: "concepts/injected",
      source: "docs",
      revision: "deadbeef",
      confirm_token: (dryRun as { confirm_token?: string }).confirm_token,
    }),
  ],
};

// Declared fields that name a whole author-written object rather than one text value.
// pages_by_change is keyed by accreta's four doubt levels, and every value under them is a page path.
// cited_paths is keyed by page path, so its keys are page text as well as its values.
const SUBTREE_FIELDS = [
  "page.frontmatter",
  "reports[].stale[].pages_by_change",
  "reports[].stale[].cited_paths",
];

// Page-derived text unmarked today, as "tool path CHANNEL". The fix belongs in src/tools.ts, not here.
const KNOWN_UNMARKED: string[] = [];

// Surfaced but not page-authored, as "tool path CHANNEL" with why. Empty: a page's path is marked wherever it is not the caller's echo.
const ACCEPTED_IDENTIFIERS: Record<string, string> = {};

// check_drift reports per citation only for a source that diffs contents, and the fixture's fs source does not.
const DIFFING_SOURCE: SourceAdapter = {
  id: "lines",
  revision: async () => "rev2",
  // A page file, as any source whose root encloses the knowledge base reports; the notes cite it.
  changedSince: async () => ["knowledge/notes/CANARY-FILENAME.md"],
  // Unknown, with the cited path in its detail as an adapter's may be, so lint's unchecked_reasons carry it.
  locate: async (path) => ({ verdict: "unknown", detail: `${path} cannot be checked here` }),
  citation: () => "",
  pinRevision: () => {},
  touchedSince: async (_revision, _path, locators) =>
    new Map(locators.map((locator) => [locator, { status: "touched" as const }])),
};

// Stale without per-line diffs, so check_drift names the paths each cited-only page cites.
const PLAIN_SOURCE: SourceAdapter = {
  id: "plain",
  revision: async () => "rev2",
  changedSince: async () => ["knowledge/notes/CANARY-FILENAME.md"],
  locate: async () => ({ verdict: "found" }),
  citation: () => "",
  pinRevision: () => {},
};

// A source only the agent can reach, so check_drift lists what waits on it.
const DELEGATED_SOURCE: SourceAdapter = {
  id: "agent",
  revision: async () => {
    throw new DelegatedSourceError("agent", "a connector", "every ticket the notes cite");
  },
  changedSince: async () => [],
  locate: async () => ({ verdict: "unknown", detail: "only the agent can read this source" }),
  citation: () => "",
  pinRevision: () => {},
};

// Quotes the source in its locate detail, as git's stderr can, so cite's location.detail carries text accreta did not write.
const QUOTING_SOURCE: SourceAdapter = {
  id: "quoting",
  revision: async () => "rev1",
  changedSince: async () => [],
  locate: async () => ({ verdict: "missing", part: "locator", detail: "no CANARY-QUOTED block" }),
  citation: () => "",
  pinRevision: () => {},
};

function canariesIn(text: string): string[] {
  // Search snippets wrap each matched term in << >>, splitting the tag.
  const plain = text.replaceAll("<<", "").replaceAll(">>", "");
  return [...new Set([...plain.matchAll(CANARY)].map((m) => (m[1] ?? "").toUpperCase()))];
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

/** The kind of every value in a payload, by path, for checking what a declared field resolves to. */
function shapesOf(value: unknown, path = "", out = new Map<string, Set<string>>()) {
  const kind = Array.isArray(value) ? "array" : value === null ? "null" : typeof value;
  out.set(path, (out.get(path) ?? new Set()).add(kind));
  if (Array.isArray(value)) for (const item of value) shapesOf(item, `${path}[]`, out);
  else if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value))
      shapesOf(child, path ? `${path}.${key}` : key, out);
  }
  return out;
}

function covers(field: string, path: string): boolean {
  return path === field || path.startsWith(`${field}.`) || path.startsWith(`${field}[]`);
}

interface Leak {
  path: string;
  channel: string;
  /** The declared field that marks it; absent when nothing does. */
  field?: string;
}

/** Canary-bearing strings in one payload, each with the `_provenance` field that marks it, if any. */
function audit(payload: unknown, declared?: string[]): { declared: string[]; leaks: Leak[] } {
  const block = (payload as { _provenance?: { page_derived_fields?: unknown } } | null)
    ?._provenance;
  const listed = block?.page_derived_fields;
  const fields =
    declared ?? (Array.isArray(listed) ? listed.filter((f) => typeof f === "string") : []);
  const leaks: Leak[] = [];
  for (const [path, text] of strings(payload)) {
    // The label itself must never carry page text, so nothing marks it.
    const field = covers("_provenance", path) ? undefined : fields.find((f) => covers(f, path));
    for (const channel of canariesIn(text)) leaks.push({ path, channel, field });
  }
  return { declared: fields, leaks };
}

/** Audit a whole CallToolResult: JSON text items against their own `_provenance`, everything else unmarked. */
function auditResult(result: unknown) {
  const { content, ...rest } = result as { content?: unknown[] };
  const payloads: unknown[] = [];
  const residue = (content ?? []).map((item) => {
    const text = (item as { type?: string; text?: unknown }).text;
    if ((item as { type?: string }).type === "text" && typeof text === "string") {
      try {
        const parsed = JSON.parse(text) as unknown;
        if (parsed !== null && typeof parsed === "object") {
          payloads.push(parsed);
          return { ...(item as object), text: "<audited as JSON>" };
        }
      } catch {
        // Not JSON: audited below as an unmarked string.
      }
    }
    return item;
  });
  const declared: string[] = [];
  const leaks: Leak[] = [];
  for (const payload of payloads) {
    const one = audit(payload);
    declared.push(...one.declared);
    leaks.push(...one.leaks);
  }
  const outside = audit({ result: { ...rest, content: residue } }, []);
  return { payloads, declared, leaks: [...leaks, ...outside.leaks] };
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

describe("every tool response, against pages that try to give instructions", () => {
  const unmarked = new Set<string>();
  const seenBy = new Map<string, Set<string>>();
  const declaredBy = new Map<string, Set<string>>();
  const markedFieldsSeen = new Set<string>();
  const shapesBy = new Map<string, Map<string, Set<string>>>();
  const tools: string[] = [];
  let capabilities: Record<string, unknown> = {};

  beforeAll(async () => {
    // Writes on, so the write tool is enumerated and swept like the rest.
    const ctx = contextWith("1");
    ctx.sources.set("lines", DIFFING_SOURCE);
    ctx.sources.set("agent", DELEGATED_SOURCE);
    ctx.sources.set("quoting", QUOTING_SOURCE);
    ctx.sources.set("plain", PLAIN_SOURCE);
    const client = await connect(ctx);
    try {
      capabilities = client.getServerCapabilities() ?? {};
      const listed = await client.listTools();
      // The confirmed write edits a page on disk, so it runs after every read.
      const ordered = listed.tools.toSorted(
        (a, b) => Number(a.name === WRITE_TOOL) - Number(b.name === WRITE_TOOL),
      );
      for (const tool of ordered) {
        tools.push(tool.name);
        const seen = new Set<string>();
        const declared = new Set<string>();
        const shapes = new Map<string, Set<string>>();
        let previous: unknown;
        for (const probe of PROBES[tool.name] ?? []) {
          const args = typeof probe === "function" ? probe(previous) : probe;
          const result = await client.callTool({ name: tool.name, arguments: args });
          const audited = auditResult(result);
          previous = audited.payloads[0];
          for (const payload of audited.payloads) shapesOf(payload, "", shapes);
          for (const field of audited.declared) declared.add(field);
          for (const leak of audited.leaks) {
            seen.add(leak.channel);
            if (leak.field) markedFieldsSeen.add(`${tool.name} ${leak.field}`);
            else unmarked.add(`${tool.name} ${leak.path} ${leak.channel}`);
          }
        }
        seenBy.set(tool.name, seen);
        declaredBy.set(tool.name, declared);
        shapesBy.set(tool.name, shapes);
      }
    } finally {
      await client.close();
      ctx.db.close();
    }
  });

  test("the server exposes tools only, so no other surface bypasses this sweep", () => {
    expect(capabilities.resources).toBeUndefined();
    expect(capabilities.prompts).toBeUndefined();
  });

  test("every registered tool has a probe", () => {
    // A new tool without one would be swept with nothing and pass by default.
    expect(tools.filter((name) => !(name in PROBES))).toEqual([]);
  });

  test("every tool surfaced some page text", () => {
    // A blind probe sees nothing, so an unmarked field on that tool would pass unnoticed.
    const blind = tools.filter((name) => (seenBy.get(name)?.size ?? 0) === 0);
    expect(blind).toEqual([]);
  });

  test("every declared page_derived_fields entry was seen carrying page text", () => {
    const unseen = tools.flatMap((name) =>
      [...(declaredBy.get(name) ?? [])]
        .map((field) => `${name} ${field}`)
        .filter((key) => !markedFieldsSeen.has(key)),
    );
    expect(unseen).toEqual([]);
  });

  test("every declared field names a text value, not a subtree that would cover new siblings", () => {
    const broad = tools.flatMap((name) => {
      const shapes = shapesBy.get(name) ?? new Map<string, Set<string>>();
      return [...(declaredBy.get(name) ?? [])]
        .filter((field) => !SUBTREE_FIELDS.includes(field))
        .filter((field) => {
          // Null is a text field left empty, as a page with no source has.
          const at = [...(shapes.get(field) ?? [])].filter((k) => k !== "null");
          const items = [...(shapes.get(`${field}[]`) ?? [])];
          const text = at.length > 0 && at.every((k) => k === "string");
          const list =
            at.length > 0 && at.every((k) => k === "array") && items.every((k) => k === "string");
          return !text && !list;
        })
        .map((field) => `${name} ${field}`);
    });
    expect(broad).toEqual([]);
  });

  test("every canary in the fixture reaches some response, including the channels #139 names", () => {
    // A canary nothing surfaces means a probe went blind, and the sweep would pass by default.
    const planted = readdirSync(FIXTURE, { recursive: true, encoding: "utf-8" })
      .filter((name) => name.endsWith(".md"))
      .flatMap((name) => [
        ...canariesIn(basename(name)),
        ...canariesIn(readFileSync(join(FIXTURE, name), "utf-8")),
      ]);
    const seen = new Set([...seenBy.values()].flatMap((channels) => [...channels]));
    expect(planted).toEqual(expect.arrayContaining(REQUIRED_CHANNELS));
    expect([...new Set(planted)].filter((channel) => !seen.has(channel))).toEqual([]);
  });

  test("no page-derived string reaches the model outside a field _provenance names", () => {
    const allowed = new Set([...KNOWN_UNMARKED, ...Object.keys(ACCEPTED_IDENTIFIERS)]);
    expect([...unmarked].filter((leak) => !allowed.has(leak)).toSorted()).toEqual([]);
  });

  test("every known gap and accepted identifier is still observed", () => {
    // Fails once a gap is marked, so the lists shrink rather than going stale.
    const listed = [...KNOWN_UNMARKED, ...Object.keys(ACCEPTED_IDENTIFIERS)];
    expect(listed.filter((leak) => !unmarked.has(leak))).toEqual([]);
  });

  test("the known-gap list does not grow", () => {
    // Adding a gap takes two edits, so it is a decision rather than a convenience.
    expect(KNOWN_UNMARKED.length).toBeLessThanOrEqual(0);
  });
});

describe("the audit itself", () => {
  test("flags a canary in a field the response does not name", () => {
    const payload = {
      results: [{ title: "CANARY-TITLE x", summary: "CANARY-BODY y", path: "a.md" }],
      _provenance: { page_derived_fields: ["results[].title"] },
    };
    const unmarked = audit(payload).leaks.filter((leak) => !leak.field);
    expect(unmarked).toEqual([{ path: "results[].summary", channel: "BODY", field: undefined }]);
  });

  test("a named field covers what is nested under it, keys included", () => {
    const payload = {
      page: { frontmatter: { "CANARY-KEY k": "CANARY-FIELD v", nested: ["CANARY-ALIAS a"] } },
      _provenance: { page_derived_fields: ["page.frontmatter"] },
    };
    const { leaks } = audit(payload);
    expect(leaks.every((leak) => leak.field === "page.frontmatter")).toBe(true);
    expect(leaks.map((leak) => leak.channel).toSorted()).toEqual(["ALIAS", "FIELD", "KEY"]);
  });

  test("a response with no _provenance block marks nothing", () => {
    expect(audit({ reports: [{ revision: "CANARY-REVISION r" }] }).leaks).toEqual([
      { path: "reports[].revision", channel: "REVISION", field: undefined },
    ]);
  });

  test("a prefix match is on a field boundary, not a substring", () => {
    const payload = {
      results: [{ title_extra: "CANARY-TITLE x" }],
      _provenance: { page_derived_fields: ["results[].title"] },
    };
    expect(audit(payload).leaks.filter((leak) => !leak.field)).toHaveLength(1);
  });

  test("a lower-cased or highlighted tag is still found", () => {
    expect(canariesIn("x <<canary>>-title y")).toEqual(["TITLE"]);
  });

  test("page text inside _provenance itself is unmarked", () => {
    const payload = {
      _provenance: { page_derived_fields: ["_provenance"], notice: "CANARY-BODY" },
    };
    expect(audit(payload).leaks.filter((leak) => !leak.field)).toHaveLength(1);
  });

  test("structuredContent and non-text items are audited as unmarked", () => {
    const result = {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            title: "CANARY-TITLE",
            _provenance: { page_derived_fields: ["title"] },
          }),
        },
        { type: "resource", resource: { uri: "x", text: "CANARY-BODY" } },
      ],
      structuredContent: { excerpt: "CANARY-BODY" },
    };
    const unmarked = auditResult(result)
      .leaks.filter((leak) => !leak.field)
      .map((leak) => leak.path);
    expect(unmarked.toSorted()).toEqual([
      "result.content[].resource.text",
      "result.structuredContent.excerpt",
    ]);
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
        expect(names).not.toContain(WRITE_TOOL);
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
      expect(names).toContain(WRITE_TOOL);
    } finally {
      await client.close();
      ctx.db.close();
    }
  });
});
