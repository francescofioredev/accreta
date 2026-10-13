import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, type AccretaConfig } from "../src/config.ts";
import { buildIndex } from "../src/index-db/build.ts";
import { openIndex, type Database } from "../src/index-db/db.ts";
import { findCanonical, findCanonicalPage, findRelated } from "../src/query/page.ts";
import { lint, lintCitations, lintKnowledgeBase } from "../src/query/lint.ts";
import { InvalidCursorError, type PageInfo, type PageRequest } from "../src/query/paging.ts";
import type { SourceAdapter } from "../src/source/adapter.ts";

let root = "";
let indexPath = "";
let db: Database | undefined;

const config: AccretaConfig = {
  ...DEFAULT_CONFIG,
  knowledgeBase: "knowledge",
  pageTypes: ["note"],
  linkFields: ["related", "discussed_in"],
};

function writePage(relativePath: string, contents: string): void {
  const full = join(root, "knowledge", relativePath);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, contents, "utf-8");
}

function reindex(): Database {
  db?.close();
  buildIndex({ root, config, indexPath });
  db = openIndex(indexPath, { readonly: true });
  return db;
}

/** Follow nextCursor to the end, the way an agent would. */
function drain<T>(fetch: (page: PageRequest) => { items: T[] } & PageInfo, limit: number) {
  const seen: T[] = [];
  const totals: number[] = [];
  let cursor: string | undefined;
  do {
    const page = fetch({ limit, cursor });
    expect(page.items.length).toBeLessThanOrEqual(limit);
    seen.push(...page.items);
    totals.push(page.total);
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  return { seen, totals };
}

// A hub with `inbound` relations in, over two kinds, and two out.
function writeStar(inbound: number): void {
  writePage("hub.md", "---\ntype: note\nrelated: [[x1]]\ndiscussed_in: [[x2]]\n---\n\n# Hub\n");
  writePage("x1.md", "---\ntype: note\n---\n\n# X1\n");
  writePage("x2.md", "---\ntype: note\n---\n\n# X2\n");
  for (let i = 0; i < inbound; i++) {
    const kind = i % 2 === 0 ? "related" : "discussed_in";
    writePage(`p${i}.md`, `---\ntype: note\n${kind}: [[hub]]\n---\n\n# P${i}\n`);
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "accreta-paging-"));
  indexPath = join(root, ".index", "accreta.sqlite");
});

afterEach(() => {
  db?.close();
  db = undefined;
  rmSync(root, { recursive: true, force: true });
});

describe("findRelated, paged", () => {
  test("following the cursor yields exactly the unpaged list, in order", () => {
    writeStar(7);
    const d = reindex();
    const all = findRelated(d, "hub", config).relations;
    expect(all).toHaveLength(9);

    const { seen, totals } = drain((page) => {
      const r = findRelated(d, "hub", config, { page });
      return { ...r, items: r.relations };
    }, 2);
    expect(seen).toEqual(all);
    expect(new Set(totals)).toEqual(new Set([9]));
  });

  test("a page straddling inbound and outbound keeps both directions", () => {
    writeStar(7);
    const d = reindex();
    const first = findRelated(d, "hub", config, { page: { limit: 6 } });
    const second = findRelated(d, "hub", config, { page: { cursor: first.nextCursor } });
    expect(second.relations.map((r) => r.direction)).toEqual(["inbound", "outbound", "outbound"]);
    expect(second.nextCursor).toBeUndefined();
  });

  test("without a page every relation is returned, which the CLI relies on", () => {
    writeStar(60);
    const d = reindex();
    const all = findRelated(d, "hub", config);
    expect(all.relations).toHaveLength(62);
    expect(all.total).toBe(62);
    expect(all.nextCursor).toBeUndefined();
  });

  test("the default page is 50, and the limit is clamped to 1..50", () => {
    writeStar(60);
    const d = reindex();
    const byDefault = findRelated(d, "hub", config, { page: {} });
    expect(byDefault.relations).toHaveLength(50);
    expect(byDefault.total).toBe(62);
    expect(byDefault.nextCursor).toBeDefined();
    expect(findRelated(d, "hub", config, { page: { limit: 500 } }).relations).toHaveLength(50);
    expect(findRelated(d, "hub", config, { page: { limit: 0 } }).relations).toHaveLength(1);
  });

  test("a cursor for another query is refused rather than applied", () => {
    writeStar(7);
    const d = reindex();
    const { nextCursor } = findRelated(d, "hub", config, { page: { limit: 2 } });
    expect(() => findRelated(d, "x1", config, { page: { cursor: nextCursor } })).toThrow(
      InvalidCursorError,
    );
    expect(() =>
      findRelated(d, "hub", config, { kinds: ["related"], page: { cursor: nextCursor } }),
    ).toThrow(InvalidCursorError);
    expect(() => findRelated(d, "hub", config, { page: { cursor: "garbage" } })).toThrow(
      InvalidCursorError,
    );
  });

  // An offset replayed over a rebuilt index skips or repeats relations silently.
  test("a cursor does not survive a reindex", () => {
    writeStar(7);
    const { nextCursor } = findRelated(reindex(), "hub", config, { page: { limit: 2 } });
    writePage("new.md", "---\ntype: note\nrelated: [[hub]]\n---\n\n# New\n");
    const d = reindex();
    expect(() => findRelated(d, "hub", config, { page: { cursor: nextCursor } })).toThrow(
      InvalidCursorError,
    );
  });

  // An older accreta builds indexes with no build_id; its cursors must still die on a rebuild.
  test("without a build_id, a cursor still does not survive a reindex", () => {
    writeStar(7);
    reindex();
    const { nextCursor } = findRelated(dropMeta("build_id"), "hub", config, {
      page: { limit: 2 },
    });
    // The fallback is last_reindex_at, whose resolution is a millisecond.
    Bun.sleepSync(2);
    reindex();
    const d = dropMeta("build_id");
    expect(() => findRelated(d, "hub", config, { page: { cursor: nextCursor } })).toThrow(
      InvalidCursorError,
    );
  });

  test("an index recording no build at all refuses every cursor", () => {
    writeStar(7);
    reindex();
    const d = dropMeta("build_id", "last_reindex_at");
    const first = findRelated(d, "hub", config, { page: { limit: 2 } });
    expect(first.relations).toHaveLength(2);
    expect(() => findRelated(d, "hub", config, { page: { cursor: first.nextCursor } })).toThrow(
      InvalidCursorError,
    );
  });
});

function dropMeta(...keys: string[]): Database {
  db?.close();
  const writable = new DatabaseSync(indexPath);
  for (const key of keys) writable.prepare("DELETE FROM meta WHERE key = ?").run(key);
  writable.close();
  db = openIndex(indexPath, { readonly: true });
  return db;
}

describe("findCanonicalPage", () => {
  test("pages through every match with the untruncated total", () => {
    for (let i = 0; i < 5; i++) {
      writePage(`c${i}.md`, `---\ntype: note\naliases: ["shared term"]\n---\n\n# C${i}\n`);
    }
    const d = reindex();
    const all = findCanonical(d, "shared term", config);
    expect(all).toHaveLength(5);

    const { seen, totals } = drain((page) => {
      const r = findCanonicalPage(d, "shared term", config, page);
      return { ...r, items: r.results };
    }, 2);
    expect(seen).toEqual(all);
    expect(new Set(totals)).toEqual(new Set([5]));
  });
});

const adapter: SourceAdapter = {
  id: "s",
  revision: async () => "rev",
  changedSince: async () => [],
  locate: async (path, locator) =>
    path === "doc.md" && locator === "L1"
      ? { verdict: "found" }
      : { verdict: "missing", part: "path", detail: `${path} does not exist` },
  citation: () => "",
  pinRevision: () => {},
};
const sources = new Map([[adapter.id, adapter]]);

describe("lintKnowledgeBase", () => {
  beforeEach(() => {
    writePage("a.md", "---\ntype: note\n---\n\n# A\n");
    writePage("b.md", "---\ntype: note\nrelated: [[missing]]\n---\n\n# B\n");
    writePage(
      "c.md",
      '---\ntype: note\ncanonical_source: "s:gone.md#L1"\nlast_verified_revision: r1\n---\n\n# C\n',
    );
    writePage(
      "d.md",
      '---\ntype: note\ncanonical_source: "s:doc.md#L1"\nlast_verified_revision: r1\n---\n\n# D\n',
    );
  });

  test("without a page it is lint and lintCitations, concatenated", async () => {
    const d = reindex();
    const report = await lintKnowledgeBase(d, config, sources);
    const expected = [...lint(d, config).findings, ...(await lintCitations(d, sources)).findings];
    expect(report.findings).toEqual(expected);
    expect(report.total).toBe(expected.length);
    expect(report.nextCursor).toBeUndefined();
  });

  test("the page bounds the combined findings; the counts stay totals", async () => {
    const d = reindex();
    const whole = await lintKnowledgeBase(d, config, sources);
    const kinds = whole.findings.map((f) => f.kind);
    expect(kinds).toContain("citation-path-missing");

    const pages: (typeof whole)[] = [];
    let cursor: string | undefined;
    do {
      const page = await lintKnowledgeBase(d, config, sources, { page: { limit: 2, cursor } });
      pages.push(page);
      cursor = page.nextCursor;
    } while (cursor !== undefined);

    expect(pages.flatMap((p) => p.findings)).toEqual(whole.findings);
    for (const page of pages) {
      expect(page.findings.length).toBeLessThanOrEqual(2);
      expect(page.total).toBe(whole.total);
      expect(page.citationsChecked).toBe(whole.citationsChecked);
      expect(page.pagesChecked).toBe(whole.pagesChecked);
    }
  });

  test("a cursor is refused once the findings have changed", async () => {
    const d = reindex();
    const first = await lintKnowledgeBase(d, config, sources, { page: { limit: 1 } });
    const fixed: SourceAdapter = { ...adapter, locate: async () => ({ verdict: "found" }) };
    await expect(
      lintKnowledgeBase(d, config, new Map([["s", fixed]]), { page: { cursor: first.nextCursor } }),
    ).rejects.toThrow(InvalidCursorError);
  });

  // The ADR's kind filter: findings nobody can fix yet must not hide the ones that can be.
  test("a kind filter reaches findings that sit behind a full page of others", async () => {
    for (let i = 0; i < 60; i++) {
      writePage(`z${i}.md`, `---\ntype: note\nrelated: [[nowhere-${i}]]\n---\n\n# Z${i}\n`);
    }
    const d = reindex();
    const unfiltered = await lintKnowledgeBase(d, config, sources, { page: {} });
    expect(unfiltered.findings.map((f) => f.kind)).not.toContain("citation-path-missing");

    const only = await lintKnowledgeBase(d, config, sources, {
      page: {},
      kinds: ["citation-path-missing"],
    });
    expect(only.findings.map((f) => f.kind)).toEqual(["citation-path-missing"]);
    expect(only.total).toBe(1);
    expect(only.citationsChecked).toBe(unfiltered.citationsChecked);
  });

  test("a cursor does not carry over to another kind filter", async () => {
    const d = reindex();
    const first = await lintKnowledgeBase(d, config, sources, { page: { limit: 1 } });
    await expect(
      lintKnowledgeBase(d, config, sources, {
        page: { cursor: first.nextCursor },
        kinds: ["dangling-link"],
      }),
    ).rejects.toThrow(InvalidCursorError);
  });

  test("findings about the sources sit between index and citation findings, and are paged and filtered with them", async () => {
    const d = reindex();
    const unloaded = {
      kind: "unloaded-source" as const,
      path: "sources/typo.yaml",
      detail: "did not load",
    };
    const whole = await lintKnowledgeBase(d, config, sources, { sourceFindings: [unloaded] });
    const indexCount = lint(d, config).findings.length;
    expect(whole.findings[indexCount]).toEqual(unloaded);
    expect(whole.total).toBe(indexCount + 1 + (await lintCitations(d, sources)).findings.length);

    const only = await lintKnowledgeBase(d, config, sources, {
      page: {},
      kinds: ["unloaded-source"],
      sourceFindings: [unloaded],
    });
    expect(only.findings).toEqual([unloaded]);
    expect(only.total).toBe(1);
    expect(only.uncheckedReasons).toEqual(whole.uncheckedReasons);
  });
});
