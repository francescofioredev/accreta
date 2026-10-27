import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildIndex,
  DelegatedSourceError,
  detectDrift,
  openIndex,
  parseConfig,
  type DriftReport,
  type LocatorChange,
  type SourceAdapter,
} from "@accreta/core";
import { countUnchecked, type UncheckedSource } from "@accreta/adapters";
import { drift, printText, readBase, toGithub, toJson } from "../src/commands/drift.ts";
import { loadSources } from "../src/commands/shared.ts";
import { findWorkspace } from "../src/workspace.ts";

// The MCP injection sweep's knowledge base: every page-authored string carries a canary tag.
const FIXTURE = join(import.meta.dir, "..", "..", "mcp-server", "test", "fixtures", "injected-kb");
const CANARY = /canary-([a-z]+)/gi;

// Pins citations at a page-authored revision, which the shared fixture's pins are not.
const PINNED_PAGE = `---
type: note
source: docs
---

# Pinned

Cites the diffing and the per-file source at a revision the page names.[^CANARY-FOOTNOTE-a][^CANARY-FOOTNOTE-b]

[^CANARY-FOOTNOTE-a]: lines @ CANARY-REVISION-pin · knowledge/notes/CANARY-FILENAME.md#CANARY-LOCATOR
[^CANARY-FOOTNOTE-b]: plain @ CANARY-REVISION-pin · knowledge/notes/CANARY-FILENAME.md#CANARY-LOCATOR-plain
`;

/** A source that diffs contents and answers every cited place with `change`. */
const diffing = (change: LocatorChange): SourceAdapter => ({
  id: "lines",
  revision: async () => "rev2",
  changedSince: async () => ["knowledge/notes/CANARY-FILENAME.md"],
  locate: async () => ({ verdict: "found" }),
  citation: () => "",
  pinRevision: () => {},
  touchedSince: async (_revision, _path, locators) =>
    new Map(locators.map((locator) => [locator, change])),
});

const PLAIN: SourceAdapter = {
  id: "plain",
  revision: async () => "rev2",
  changedSince: async () => ["knowledge/notes/CANARY-FILENAME.md"],
  locate: async () => ({ verdict: "found" }),
  citation: () => "",
  pinRevision: () => {},
};

/** Refuses every place it is asked about, naming the cited path back as git's error does. */
const refusing = (adapter: SourceAdapter): SourceAdapter => ({
  ...adapter,
  changedSince: async () => ["elsewhere.md"],
  locate: async (path) => ({ verdict: "missing", part: "path", detail: `${path} is a symlink` }),
});

const DELEGATED: SourceAdapter = {
  id: "agent",
  revision: async () => {
    throw new DelegatedSourceError("agent", "a CANARY-VIA connector", "every ticket");
  },
  changedSince: async () => [],
  locate: async () => ({ verdict: "unknown", detail: "only the agent can read this source" }),
  citation: () => "",
  pinRevision: () => {},
};

/** Every string in a value, keys included, with its path in `_provenance` notation. */
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

const covers = (field: string, path: string) =>
  path === field || path.startsWith(`${field}.`) || path.startsWith(`${field}[]`);

const canaries = (text: string) => [...text.matchAll(CANARY)].map((m) => m[1]!.toUpperCase());

/** The report with ESC and a zero-width space after every string, so a missed escape shows. */
function taint<T>(value: T, key = ""): T {
  if (typeof value === "string") {
    // `status` is accreta's own vocabulary, and drift branches on it.
    return (key === "status" ? value : `${value}\u001b[0m\u200b`) as T;
  }
  if (Array.isArray(value)) return value.map((item) => taint(item)) as T;
  if (value !== null && typeof value === "object") {
    // citedPaths and refused are keyed by page path, so their keys must match the tainted pages.
    const entries = Object.entries(value).map(([k, v]) => [
      key === "citedPaths" || key === "refused" ? taint(k) : k,
      taint(v, k),
    ]);
    return Object.fromEntries(entries) as T;
  }
  return value;
}

let root = "";
const runs: DriftReport[][] = [];
let unloaded: UncheckedSource[] = [];

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "accreta-drift-provenance-"));
  cpSync(FIXTURE, root, { recursive: true });
  writeFileSync(join(root, "knowledge", "notes", "CANARY-FILENAME-pinned.md"), PINNED_PAGE);
  const config = parseConfig(readFileSync(join(root, "accreta.config.yaml"), "utf-8"));
  const indexPath = join(root, ".accreta", "index.sqlite");
  buildIndex({ root, config, indexPath });
  const loaded = loadSources(findWorkspace(root));
  const docs = loaded.sources;
  const db = openIndex(indexPath, { readonly: true });
  try {
    // The fixture's hostile declarations, which `unloaded_sources` quotes.
    unloaded = countUnchecked(db, loaded.unloaded);
    // Touched lines fill `in_doubt`, moved ones `repin`: no single run shows both for one citation.
    for (const change of [{ status: "touched" }, { status: "moved", locator: "L9" }] as const) {
      const run: DriftReport[] = [];
      for (const adapter of [...docs, diffing(change), PLAIN, DELEGATED]) {
        run.push(await detectDrift(db, adapter));
      }
      runs.push(run);
    }
    // A refusal lands in `citations[]` with a diff and in the page's `refused[]` without one.
    runs.push([
      await detectDrift(db, refusing(diffing({ status: "untouched" }))),
      await detectDrift(db, refusing(PLAIN)),
    ]);
  } finally {
    db.close();
  }
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("drift --json against pages that try to give instructions", () => {
  const payloads = () => {
    const plain = runs.map((reports) => toJson(reports, undefined, unloaded));
    const basePath = join(root, "base.json");
    writeFileSync(basePath, JSON.stringify(plain[0]));
    return [...plain, ...runs.map((reports) => toJson(reports, readBase(basePath), unloaded))];
  };

  test("every page-authored string sits in a field _provenance names", () => {
    const unmarked: string[] = [];
    for (const payload of payloads()) {
      const fields = payload._provenance.page_derived_fields;
      for (const [path, text] of strings(payload)) {
        if (canaries(text).length === 0) continue;
        if (covers("_provenance", path) || !fields.some((f) => covers(f, path))) {
          unmarked.push(`${path} ${canaries(text).join(",")}`);
        }
      }
    }
    expect([...new Set(unmarked)].toSorted()).toEqual([]);
  });

  test("every declared field was seen carrying page text, so none is a stale name", () => {
    const seen = new Set<string>();
    let declared: readonly string[] = [];
    for (const payload of payloads()) {
      declared = payload._provenance.page_derived_fields;
      for (const [path, text] of strings(payload)) {
        if (canaries(text).length === 0) continue;
        for (const field of declared) if (covers(field, path)) seen.add(field);
      }
    }
    expect(declared.filter((field) => !seen.has(field))).toEqual([]);
  });

  test("the label is check_drift's notice, and --base reads past it", () => {
    const [first] = payloads();
    expect(first!._provenance.notice).toContain("does not prevent");
    const path = join(root, "labelled.json");
    writeFileSync(path, JSON.stringify(first));
    const { _provenance: _, ...bare } = first!;
    const barePath = join(root, "bare.json");
    writeFileSync(barePath, JSON.stringify(bare));
    expect([...readBase(path)]).toEqual([...readBase(barePath)]);
    expect(toJson(runs[0]!, readBase(path)).pages_newly_in_doubt).toBe(0);
  });
});

describe("drift's other formats, against the same pages", () => {
  // Written as escapes: a raw bidi control in a test file is itself a hazard.
  const UNSAFE = /[\p{Cc}\p{Cf}\u2028\u2029]/u;

  test("--format github renders every page-authored string as inline code", () => {
    for (const reports of runs) {
      const out = toGithub(reports);
      expect(canaries(out).length).toBeGreaterThan(0);
      // CommonMark code spans: a backtick run, then the first run of the same length.
      const outside = out.replaceAll(/(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)/g, "");
      expect(canaries(outside)).toEqual([]);
    }
  });

  const controls: DriftReport = {
    sourceId: "docs\u001b[1m",
    currentRevision: "now\u0007",
    stale: [
      {
        revision: "r1\u001b[2J\nup to date",
        changedPaths: [],
        pages: ["a\u202eb.md", "e\u200b.md", "f\\u0041.md"],
      },
    ],
    unverifiable: [],
    unresolvable: [{ revision: "gone\r\u061c", pages: ["c\u0007.md"] }],
    unpinned: [{ page: "d\u0007.md", footnote: "1\u001b]0;x\u{e0041}" }],
    delegated: null,
  };
  const delegated: DriftReport = {
    sourceId: "agent\u001b[2J",
    currentRevision: null,
    stale: [],
    unverifiable: [],
    unresolvable: [],
    delegated: {
      via: "a connector\u0007",
      guidance: "every ticket\u202e\nup to date\u2028done",
      pending: [{ revision: "r\u061c", pages: ["p\u200b.md"] }],
    },
  };

  test("no string in a report reaches the text or github output with its control characters", () => {
    let escaped = 0;
    for (const reports of runs) {
      const tainted = reports.map((report) => taint(report));
      const lines: string[] = [];
      for (const report of tainted) printText({ out: (line) => lines.push(line) }, report);
      lines.push(...toGithub(tainted).split("\n"));
      expect(lines.filter((line) => UNSAFE.test(line))).toEqual([]);
      escaped += lines.filter((line) => line.includes("\\u200b")).length;
    }
    expect(escaped).toBeGreaterThan(0);
  });

  test("--format github escapes a page's control characters inside the code span", () => {
    const out = toGithub([controls]);
    expect(out).toContain("`a\\u202eb.md`");
    expect(out).toContain("`e\\u200b.md`");
    expect(out).toContain("`r1\\u001b[2J up to date`");
    expect(out).toContain("`[^1\\u001b]0;x\\u{e0041}]`");
    expect(out.split("\n").filter((line) => UNSAFE.test(line))).toEqual([]);
  });

  test("the text format prints a page's control characters escaped, not raw", () => {
    const lines: string[] = [];
    printText({ out: (line) => lines.push(line) }, controls);
    const out = lines.join("\n");
    expect(out).toContain("docs\\u001b[1m @ now\\u0007");
    expect(out).toContain("a\\u202eb.md (verified at r1\\u001b[2J\\u000aup to date)");
    expect(out).toContain("e\\u200b.md (verified at");
    // A path that spells an escape cannot pass for one.
    expect(out).toContain("f\\\\u0041.md (verified at");
    expect(lines).toContain("    gone\\u000d\\u061c:");
    expect(lines).toContain("      c\\u0007.md (verified)");
    expect(out).toContain("d\\u0007.md [^1\\u001b]0;x\\u{e0041}]");
    expect(lines.filter((line) => UNSAFE.test(line))).toEqual([]);
  });

  test("the text format escapes a delegated source's work order", () => {
    const lines: string[] = [];
    printText({ out: (line) => lines.push(line) }, delegated);
    expect(lines).toContain(
      "agent\\u001b[2J — read through a connector\\u0007 by the agent, not by accreta",
    );
    expect(lines).toContain("    p\\u200b.md (verified at r\\u061c)");
    expect(lines).toContain("    | every ticket\\u202e");
    expect(lines).toContain("    | up to date\\u2028done");
    expect(lines.filter((line) => UNSAFE.test(line))).toEqual([]);
  });

  test("the text format escapes a broken declaration's file and reason", async () => {
    // In `type`: an id holding a control character no longer loads far enough to be quoted.
    const hostile = 'id: dup\ntype: "fs\\e[2J"\nroot: sources/docs\n';
    writeFileSync(join(root, "sources", "dup\u200b-a.yaml"), hostile);
    const lines: string[] = [];
    const code = await drift({ cwd: root, out: (line) => lines.push(line), err: () => {} });
    expect(code).toBe(1);
    expect(lines.join("\n")).toContain("fs\\u001b[2J");
    expect(lines.join("\n")).toContain("dup\\u200b-a.yaml");
    expect(lines.filter((line) => UNSAFE.test(line))).toEqual([]);

    const errors: string[] = [];
    const missing = await drift({ cwd: root, out: () => {}, err: (line) => errors.push(line) }, [
      "--source",
      "nope\u001b[2J",
    ]);
    expect(missing).toBe(2);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.flatMap((line) => line.split("\n")).filter((line) => UNSAFE.test(line))).toEqual(
      [],
    );
  });
});
