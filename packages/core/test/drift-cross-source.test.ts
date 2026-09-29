import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectDrift, pageChanges } from "../src/source/drift.ts";
import {
  DelegatedSourceError,
  UNPINNED_REVISION,
  UnknownRevisionError,
  type LocationVerdict,
  type LocatorChange,
  type SourceAdapter,
} from "../src/source/adapter.ts";
import { openIndex, type Database } from "../src/index-db/db.ts";

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

  async locate(): Promise<LocationVerdict> {
    return { verdict: "found" };
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
  db.query(
    `INSERT INTO pages (path, type, title, source, canonical_source, last_verified_revision, frontmatter_json, body, mtime)
     VALUES (?, 'note', ?, ?, ?, ?, '{}', '', 0)`,
  ).run(path, path, source, canonical ?? null, verifiedAt);
}

let line = 0;
function addFootnote(page: string, footnote: string, revision: string, path: string, at: string) {
  db.query(
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

  test("a page none of whose cited files changed is not named, even per file", async () => {
    // It never claimed to rest on the rest of this source, as the source's own pages do.
    addPage("knowledge/contradiction.md", "ipcc", "ipcc1");
    addFootnote("knowledge/contradiction.md", "b", "rev1", "note.md", "L5");
    const report = await detectDrift(
      db,
      new ScriptedSource("noaa", "rev2", { rev1: ["other.md"] }),
    );
    expect(report.stale).toEqual([]);
  });

  test("an unpinned footnote falls back to the page's last_verified_revision", async () => {
    addPage("knowledge/contradiction.md", "ipcc", "rev1");
    addFootnote("knowledge/contradiction.md", "b", UNPINNED_REVISION, "note.md", "L5");
    const noaa = new ScriptedSource(
      "noaa",
      "rev2",
      { rev1: ["note.md"] },
      { "rev1 note.md": { L5: { status: "touched" } } },
    );

    const report = await detectDrift(db, noaa);

    expect(noaa.asked).toEqual(["rev1 note.md L5"]);
    expect(pageChanges(report.stale[0]!)?.get("knowledge/contradiction.md")).toBe("changed");
  });

  test("an unpinned footnote on a page recording no revision is unverifiable", async () => {
    addPage("knowledge/contradiction.md", "ipcc", null);
    addFootnote("knowledge/contradiction.md", "b", UNPINNED_REVISION, "note.md", "L5");
    const report = await detectDrift(db, new ScriptedSource("noaa", "rev2", {}));
    expect(report.unverifiable).toEqual(["knowledge/contradiction.md"]);
  });

  test("a footnote revision the source cannot place is unresolvable, not current", async () => {
    addPage("knowledge/contradiction.md", "ipcc", "ipcc1");
    addFootnote("knowledge/contradiction.md", "b", "gone", "note.md", "L5");
    const report = await detectDrift(db, new ScriptedSource("noaa", "rev2", {}));
    expect(report.unresolvable).toEqual([
      { revision: "gone", pages: ["knowledge/contradiction.md"] },
    ]);
  });

  test("a canonical_source into this source counts too", async () => {
    addPage("knowledge/contradiction.md", "ipcc", "rev1", "noaa:note.md");
    const noaa = new ScriptedSource("noaa", "rev2", { rev1: ["note.md"] }, {});
    const report = await detectDrift(db, noaa);
    expect(report.stale[0]?.citations?.map((c) => [c.page, c.change.status])).toEqual([
      ["knowledge/contradiction.md", "touched"],
    ]);
  });

  test("a source only the agent can reach lists the page as pending", async () => {
    addPage("knowledge/contradiction.md", "ipcc", "ipcc1");
    addFootnote("knowledge/contradiction.md", "b", "2026-08-01", "note.md", "L5");
    const report = await detectDrift(db, new DelegatedStub("noaa"));
    expect(report.delegated?.pending).toEqual([
      { revision: "2026-08-01", pages: ["knowledge/contradiction.md"] },
    ]);
  });
});
