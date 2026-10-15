import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectDrift, pageChanges } from "../src/source/drift.ts";
import {
  DelegatedSourceError,
  UNPINNED_REVISION,
  UnknownRevisionError,
  parseCitation,
  type LocationVerdict,
  type LocatorChange,
  type SourceAdapter,
} from "../src/source/adapter.ts";
import { openIndex, type Database } from "../src/index-db/db.ts";
import { buildIndex } from "../src/index-db/build.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";

class ScriptedSource implements SourceAdapter {
  readonly asked: string[] = [];

  constructor(
    readonly id: string,
    private readonly current: string,
    private readonly changes: Record<string, string[]>,
    private readonly lines?: Record<string, Record<string, LocatorChange>>,
  ) {
    if (!lines) this.touchedSince = undefined;
  }

  async revision(): Promise<string> {
    return this.current;
  }

  async changedSince(revision: string): Promise<string[]> {
    const answer = this.changes[revision];
    if (answer === undefined) throw new UnknownRevisionError(this.id, revision);
    return answer;
  }

  touchedSince?: SourceAdapter["touchedSince"] = async (revision, path, locators) => {
    this.asked.push(`${revision} ${path} ${locators.join(",")}`);
    const answer = this.lines?.[`${revision} ${path}`];
    if (answer === undefined) throw new UnknownRevisionError(this.id, revision);
    return new Map(locators.map((l) => [l, answer[l] ?? { status: "untouched" as const }]));
  };

  readonly refuses = new Set<string>();

  async locate(path: string): Promise<LocationVerdict> {
    if (!this.refuses.has(path)) return { verdict: "found" };
    return { verdict: "missing", part: "path", detail: `${path} is reached through a symlink` };
  }

  citation(path: string, locator?: string): string {
    return locator ? `${this.id}:${path}#${locator}` : `${this.id}:${path}`;
  }

  pinRevision(): void {}
}

class DelegatedStub implements SourceAdapter {
  constructor(readonly id: string) {}
  async revision(): Promise<string> {
    throw new DelegatedSourceError(this.id, "notion", "Everything.");
  }
  async changedSince(): Promise<string[]> {
    throw new DelegatedSourceError(this.id, "notion", "Everything.");
  }
  async locate(): Promise<LocationVerdict> {
    return { verdict: "unknown", detail: "the agent reads this" };
  }
  citation(path: string): string {
    return `${this.id}:${path}`;
  }
  pinRevision(): void {}
}

let root = "";
let db: Database;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "accreta-drift-cross-"));
  db = openIndex(join(root, "index.sqlite"));
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

function addPage(path: string, source: string, verifiedAt: string | null, canonical?: string) {
  db.prepare(
    `INSERT INTO pages (path, type, title, source, canonical_source, last_verified_revision, frontmatter_json, body, mtime)
     VALUES (?, 'note', ?, ?, ?, ?, '{}', '', 0)`,
  ).run(path, path, source, canonical ?? null, verifiedAt);
  const named = canonical ? parseCitation(canonical)?.sourceId : undefined;
  if (canonical && named && named !== source) {
    db.prepare(
      `INSERT INTO canonical_cites (source, page_path, canonical_source) VALUES (?, ?, ?)`,
    ).run(named, path, canonical);
  }
}

let line = 0;
function addFootnote(
  page: string,
  footnote: string,
  revision: string | null,
  path: string,
  at: string,
) {
  db.prepare(
    `INSERT INTO citations (page_path, footnote, line, text, source, revision, path, locator, claim)
     VALUES (?, ?, ?, '', 'noaa', ?, ?, ?, '')`,
  ).run(page, footnote, ++line, revision, path, at);
}

describe("a footnote into a source other than the page's own", () => {
  test("a diff in its cited lines names the page", async () => {
    addPage("knowledge/contradiction.md", "ipcc", "ipcc1");
    addFootnote("knowledge/contradiction.md", "b", "rev1", "note.md", "L5-L7");
    addFootnote("knowledge/contradiction.md", "why", "rev1", "note.md", "L9-L10");
    const noaa = new ScriptedSource(
      "noaa",
      "rev2",
      { rev1: ["note.md"] },
      { "rev1 note.md": { "L5-L7": { status: "touched" } } },
    );

    const report = await detectDrift(db, noaa);

    expect(report.stale.map((e) => [e.revision, e.pages])).toEqual([
      ["rev1", ["knowledge/contradiction.md"]],
    ]);
    expect(report.stale[0]?.citations?.map((c) => [c.footnote, c.change.status])).toEqual([
      ["b", "touched"],
      ["why", "untouched"],
    ]);
    expect(pageChanges(report.stale[0]!)?.get("knowledge/contradiction.md")).toBe("changed");
    expect(noaa.asked).toEqual(["rev1 note.md L5-L7,L9-L10"]);
  });

  test("it shares a group with the source's own pages at the same revision", async () => {
    addPage("knowledge/finding.md", "noaa", "rev1");
    addPage("knowledge/contradiction.md", "ipcc", "ipcc1");
    addFootnote("knowledge/contradiction.md", "b", "rev1", "note.md", "L5");
    const noaa = new ScriptedSource("noaa", "rev2", { rev1: ["note.md"] }, { "rev1 note.md": {} });

    const report = await detectDrift(db, noaa);

    expect(report.stale.map((e) => [e.revision, e.pages])).toEqual([
      ["rev1", ["knowledge/contradiction.md", "knowledge/finding.md"]],
    ]);
  });

  test("each footnote is diffed from its own revision", async () => {
    addPage("knowledge/contradiction.md", "ipcc", "ipcc1");
    addFootnote("knowledge/contradiction.md", "old", "rev0", "note.md", "L1");
    addFootnote("knowledge/contradiction.md", "new", "rev1", "note.md", "L2");
    const noaa = new ScriptedSource(
      "noaa",
      "rev2",
      { rev0: ["note.md"], rev1: ["note.md"] },
      { "rev0 note.md": { L1: { status: "touched" } }, "rev1 note.md": {} },
    );

    const report = await detectDrift(db, noaa);

    expect(
      report.stale.map((e) => [e.revision, e.citations?.map((c) => [c.footnote, c.change.status])]),
    ).toEqual([
      ["rev0", [["old", "touched"]]],
      ["rev1", [["new", "untouched"]]],
    ]);
  });

  test("a page none of whose cited files changed is not named by a per-file source", async () => {
    addPage("knowledge/contradiction.md", "ipcc", "ipcc1");
    addFootnote("knowledge/contradiction.md", "b", "rev1", "note.md", "L5");
    const report = await detectDrift(db, new ScriptedSource("noaa", "rev2", { rev1: ["x.md"] }));
    expect(report.stale).toEqual([]);
  });

  for (const lines of [undefined, {}]) {
    const kind = lines ? "a line-aware" : "a per-file";
    test(`a page citing only what ${kind} source refuses is named, not dropped (#303)`, async () => {
      addPage("knowledge/contradiction.md", "ipcc", "ipcc1");
      addFootnote("knowledge/contradiction.md", "b", "rev1", "link.md", "L5");
      const noaa = new ScriptedSource("noaa", "rev2", { rev1: ["real.md"] }, lines);
      noaa.refuses.add("link.md");

      const [entry] = (await detectDrift(db, noaa)).stale;

      expect(entry?.citedOnly).toEqual(["knowledge/contradiction.md"]);
      const rank = pageChanges(entry!)?.get("knowledge/contradiction.md");
      expect(rank).toBe(lines ? "changed" : undefined);
      const why = "link.md is reached through a symlink";
      if (lines) {
        expect(entry?.citations?.map((c) => [c.path, c.refused])).toEqual([["link.md", why]]);
        expect(entry?.refused).toBeUndefined();
      } else {
        // Not `real.md`: the page cites the link, and only the refusal put it here.
        expect(entry?.citedPaths).toBeUndefined();
        expect(entry?.refused).toEqual({
          "knowledge/contradiction.md": [
            { footnote: "b", path: "link.md", locator: "L5", refused: why },
          ],
        });
      }
    });
  }

  test("a per-file source says which of the changed files such a page cites", async () => {
    addPage("knowledge/contradiction.md", "ipcc", "ipcc1");
    addFootnote("knowledge/contradiction.md", "b", "rev1", "note.md", "L5");
    const changed = ["a.md", "b.md", "c.md", "d.md", "e.md", "note.md"];
    const report = await detectDrift(db, new ScriptedSource("noaa", "rev2", { rev1: changed }));
    expect(report.stale[0]?.citedOnly).toEqual(["knowledge/contradiction.md"]);
    expect(report.stale[0]?.citedPaths).toEqual({ "knowledge/contradiction.md": ["note.md"] });
  });

  test("an unpinned footnote is never read against the page's own revision", async () => {
    // The page's revision belongs to its own source; lines read against it land in the wrong place.
    addPage("knowledge/contradiction.md", "ipcc", "p1");
    addFootnote("knowledge/contradiction.md", "b", UNPINNED_REVISION, "note.md", "L15-L17");
    const noaa = new ScriptedSource(
      "noaa",
      "rev2",
      { p1: ["note.md"] },
      { "p1 note.md": { "L15-L17": { status: "moved", locator: "L25-L27" } } },
    );

    const report = await detectDrift(db, noaa);

    expect(noaa.asked).toEqual([]);
    expect(report.stale).toEqual([]);
    expect(report.unverifiable).toEqual(["knowledge/contradiction.md"]);
  });

  for (const pin of [UNPINNED_REVISION, "", null]) {
    test(`a footnote pinned at ${JSON.stringify(pin)} is unverifiable, not unplaceable`, async () => {
      addPage("knowledge/contradiction.md", "ipcc", "ipcc1");
      addFootnote("knowledge/contradiction.md", "b", pin, "note.md", "L5");
      const report = await detectDrift(db, new ScriptedSource("noaa", "rev2", {}, {}));
      expect(report.unresolvable).toEqual([]);
      expect(report.unverifiable).toEqual(["knowledge/contradiction.md"]);
    });
  }

  test("a canonical_source into this source is unverifiable: its grammar has no pin", async () => {
    addPage("knowledge/contradiction.md", "ipcc", "rev1", " noaa:note.md#L5 ");
    const noaa = new ScriptedSource("noaa", "rev2", { rev1: ["note.md"] }, {});
    const report = await detectDrift(db, noaa);
    expect(report.stale).toEqual([]);
    expect(report.unverifiable).toEqual(["knowledge/contradiction.md"]);
    expect(report.unpinned).toEqual([{ page: "knowledge/contradiction.md", footnote: null }]);
  });

  test("a built page with no source of its own is checked through its canonical_source", async () => {
    mkdirSync(join(root, "knowledge"));
    writeFileSync(
      join(root, "knowledge", "loose.md"),
      "---\ntype: note\ncanonical_source: noaa:note.md#L5\n---\n\n# Loose\n",
    );
    const indexPath = join(root, "built.sqlite");
    buildIndex({ root, config: { ...DEFAULT_CONFIG, knowledgeBase: "knowledge" }, indexPath });
    const built = openIndex(indexPath, { readonly: true });
    try {
      const report = await detectDrift(built, new ScriptedSource("noaa", "rev2", {}, {}));
      expect(report.unpinned).toEqual([{ page: "knowledge/loose.md", footnote: null }]);
    } finally {
      built.close();
    }
  });

  test("an index without the canonical_cites table says to reindex", async () => {
    addPage("knowledge/finding.md", "noaa", "rev1");
    db.exec("DROP TABLE canonical_cites");
    const noaa = new ScriptedSource("noaa", "rev1", {}, {});
    await expect(detectDrift(db, noaa)).rejects.toThrow(
      "This index predates the canonical_cites table; run `accreta reindex`.",
    );
  });

  test("a canonical_source takes the pin of a footnote citing the same lines", async () => {
    addPage("knowledge/contradiction.md", "ipcc", "ipcc1", "noaa:note.md#L5-L7");
    addFootnote("knowledge/contradiction.md", "b", "rev1", "note.md", "L5-L7");
    const noaa = new ScriptedSource(
      "noaa",
      "rev2",
      { rev1: ["note.md"] },
      { "rev1 note.md": { "L5-L7": { status: "touched" } } },
    );

    const report = await detectDrift(db, noaa);

    expect(report.unverifiable).toEqual([]);
    expect(
      report.stale[0]?.citations?.map((c) => [c.footnote, c.revision, c.change.status]),
    ).toEqual([
      [null, "rev1", "touched"],
      ["b", "rev1", "touched"],
    ]);
  });

  test("a canonical_source never borrows a pin for other lines of the file", async () => {
    // Its line numbers may belong to a later revision than a footnote elsewhere in the file.
    addPage("knowledge/contradiction.md", "ipcc", "ipcc1", "noaa:note.md#L15-L17");
    addFootnote("knowledge/contradiction.md", "b", "p0", "note.md", "L1");
    addFootnote("knowledge/contradiction.md", "why", "x", "note.md", "L19-L20");
    const noaa = new ScriptedSource(
      "noaa",
      "z",
      { p0: ["note.md"], x: ["note.md"] },
      {
        "p0 note.md": { "L15-L17": { status: "moved", locator: "L25-L27" } },
        "x note.md": {},
      },
    );

    const report = await detectDrift(db, noaa);

    expect(report.unpinned).toEqual([{ page: "knowledge/contradiction.md", footnote: null }]);
    const cited = report.stale.flatMap((e) => e.citations ?? []);
    expect(cited.filter((c) => c.footnote === null)).toEqual([]);
    expect(noaa.asked).toEqual(["p0 note.md L1", "x note.md L19-L20"]);
  });

  test("an unpinned footnote is named with its id", async () => {
    addPage("knowledge/contradiction.md", "ipcc", "ipcc1");
    addFootnote("knowledge/contradiction.md", "b", UNPINNED_REVISION, "note.md", "L5");
    const report = await detectDrift(db, new ScriptedSource("noaa", "rev2", {}));
    expect(report.unpinned).toEqual([{ page: "knowledge/contradiction.md", footnote: "b" }]);
  });

  test("a footnote revision the source cannot place is unresolvable, not current", async () => {
    addPage("knowledge/contradiction.md", "ipcc", "ipcc1");
    addFootnote("knowledge/contradiction.md", "b", "gone", "note.md", "L5");
    const report = await detectDrift(db, new ScriptedSource("noaa", "rev2", {}));
    expect(report.unresolvable).toEqual([
      {
        revision: "gone",
        pages: ["knowledge/contradiction.md"],
        citedOnly: ["knowledge/contradiction.md"],
      },
    ]);
  });

  test("a source only the agent can reach lists the page as pending", async () => {
    addPage("knowledge/contradiction.md", "ipcc", "ipcc1");
    addFootnote("knowledge/contradiction.md", "b", "2026-08-01", "note.md", "L5");
    const report = await detectDrift(db, new DelegatedStub("noaa"));
    expect(report.delegated?.pending).toEqual([
      {
        revision: "2026-08-01",
        pages: ["knowledge/contradiction.md"],
        citedOnly: ["knowledge/contradiction.md"],
      },
    ]);
  });
});

describe("a footnote pinned before its page's revision", () => {
  test("is checked from its pin even when the page's revision is current", async () => {
    addPage("knowledge/finding.md", "noaa", "rev2");
    addFootnote("knowledge/finding.md", "old", "rev0", "note.md", "L1");
    const noaa = new ScriptedSource(
      "noaa",
      "rev2",
      { rev0: ["note.md"] },
      { "rev0 note.md": { L1: { status: "touched" } } },
    );

    const report = await detectDrift(db, noaa);

    expect(report.stale.map((e) => [e.revision, e.pages, e.citedOnly])).toEqual([
      ["rev0", ["knowledge/finding.md"], ["knowledge/finding.md"]],
    ]);
    expect(pageChanges(report.stale[0]!)?.get("knowledge/finding.md")).toBe("changed");
  });

  test("is checked for files changed since its pin, not only since the page's revision", async () => {
    addPage("knowledge/finding.md", "noaa", "rev1");
    addFootnote("knowledge/finding.md", "old", "rev0", "note.md", "L1");
    const noaa = new ScriptedSource(
      "noaa",
      "rev2",
      { rev0: ["note.md", "other.md"], rev1: ["other.md"] },
      { "rev0 note.md": { L1: { status: "touched" } } },
    );

    const report = await detectDrift(db, noaa);

    expect(
      report.stale[0]?.citations?.map((c) => [c.footnote, c.revision, c.change.status]),
    ).toEqual([["old", "rev0", "touched"]]);
  });

  test("a pin the source cannot place is unresolvable, whatever else changed", async () => {
    // Pre-squash SHAs do this; an unrelated change must not turn "cannot place" into "in doubt".
    addPage("knowledge/finding.md", "noaa", "r1");
    addFootnote("knowledge/finding.md", "old", "gone", "y.md", "L1");
    const expected = [
      { revision: "gone", pages: ["knowledge/finding.md"], citedOnly: ["knowledge/finding.md"] },
    ];

    const quiet = await detectDrift(db, new ScriptedSource("noaa", "r1", {}, {}));
    const noaa = new ScriptedSource("noaa", "r2", { r1: ["other.md"] }, {});
    const busy = await detectDrift(db, noaa);

    expect(quiet.unresolvable).toEqual(expected);
    expect(busy.unresolvable).toEqual(expected);
    expect(busy.stale[0]?.citations).toEqual([]);
    expect(noaa.asked).toEqual([]);
  });
});
