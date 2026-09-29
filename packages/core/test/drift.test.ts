import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectDrift, pageChanges } from "../src/source/drift.ts";
import {
  DelegatedSourceError,
  UnknownRevisionError,
  type LocationVerdict,
  type LocatorChange,
  type SourceAdapter,
} from "../src/source/adapter.ts";
import { openIndex } from "../src/index-db/db.ts";
import type { Database } from "../src/index-db/db.ts";

/**
 * A source that answers from a script rather than from a filesystem or a
 * repository. If drift detection needed to know what kind of source it holds,
 * this would not work — which is exactly the property being tested.
 */
class ScriptedSource implements SourceAdapter {
  constructor(
    readonly id: string,
    private readonly current: string,
    private readonly changes: Record<string, string[] | "unknown">,
  ) {}

  async revision(): Promise<string> {
    return this.current;
  }

  async changedSince(revision: string): Promise<string[]> {
    const answer = this.changes[revision];
    if (answer === undefined || answer === "unknown") {
      throw new UnknownRevisionError(this.id, revision);
    }
    return answer;
  }

  async locate(): Promise<LocationVerdict> {
    return { verdict: "found" };
  }

  citation(path: string, locator?: string): string {
    return locator ? `${this.id}:${path}#${locator}` : `${this.id}:${path}`;
  }

  // This source's citations carry no revision, so there is nothing to pin.
  pinRevision(): void {}
}

let root = "";
let db: Database;

function addPage(path: string, source: string | null, verifiedAt: string | null): void {
  db.query(
    `INSERT INTO pages (path, type, title, source, last_verified_revision, frontmatter_json, body, mtime)
     VALUES (?, 'note', ?, ?, ?, '{}', '', 0)`,
  ).run(path, path, source, verifiedAt);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "accreta-drift-"));
  db = openIndex(join(root, "index.sqlite"));
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

describe("detectDrift", () => {
  test("a page verified at the current revision is not stale", async () => {
    addPage("knowledge/a.md", "docs", "rev1");
    const report = await detectDrift(db, new ScriptedSource("docs", "rev1", {}));
    expect(report.stale).toEqual([]);
  });

  test("a page verified at an older revision that saw changes is stale", async () => {
    addPage("knowledge/a.md", "docs", "rev1");
    const report = await detectDrift(
      db,
      new ScriptedSource("docs", "rev2", { rev1: ["chapter-07.md"] }),
    );
    expect(report.stale).toEqual([
      { revision: "rev1", changedPaths: ["chapter-07.md"], pages: ["knowledge/a.md"] },
    ]);
  });

  test("a source that moved without touching anything is not drift", async () => {
    // Reporting every revision bump would train the reader to ignore the report.
    addPage("knowledge/a.md", "docs", "rev1");
    const report = await detectDrift(db, new ScriptedSource("docs", "rev2", { rev1: [] }));
    expect(report.stale).toEqual([]);
  });

  test("a page recording no revision is unverifiable, not current", async () => {
    addPage("knowledge/a.md", "docs", null);
    const report = await detectDrift(db, new ScriptedSource("docs", "rev1", {}));
    expect(report.unverifiable).toEqual(["knowledge/a.md"]);
    expect(report.stale).toEqual([]);
  });

  test("a revision the source cannot place is reported, not treated as unchanged", async () => {
    // The distinction the interface exists to preserve: "I cannot tell" is a
    // different answer from "nothing changed", and only one of them is safe to
    // render as a green check.
    addPage("knowledge/a.md", "docs", "rewritten");
    const report = await detectDrift(
      db,
      new ScriptedSource("docs", "rev2", { rewritten: "unknown" }),
    );
    expect(report.unresolvable).toEqual([{ revision: "rewritten", pages: ["knowledge/a.md"] }]);
    expect(report.stale).toEqual([]);
  });

  test("pages belonging to another source are not considered", async () => {
    addPage("knowledge/a.md", "docs", "rev1");
    addPage("knowledge/b.md", "other", "rev1");
    const report = await detectDrift(db, new ScriptedSource("docs", "rev2", { rev1: ["x.md"] }));
    expect(report.stale.flatMap((entry) => entry.pages)).toEqual(["knowledge/a.md"]);
  });

  test("pages sharing a revision are diffed once and reported together", async () => {
    addPage("knowledge/a.md", "docs", "rev1");
    addPage("knowledge/b.md", "docs", "rev1");
    const report = await detectDrift(db, new ScriptedSource("docs", "rev2", { rev1: ["x.md"] }));
    expect(report.stale).toEqual([
      { revision: "rev1", changedPaths: ["x.md"], pages: ["knowledge/a.md", "knowledge/b.md"] },
    ]);
  });

  // The defect this shape exists to prevent: `changedPaths` belongs to the
  // revision, and repeating it per page made the response the product of the
  // two. Asserting on the *number of copies* rather than a byte threshold names
  // what went wrong — a size limit would pass again the moment anything else
  // shrank.
  test("changed paths are serialised once per revision, not once per page", async () => {
    for (let i = 0; i < 100; i++) addPage(`knowledge/page-${i}.md`, "docs", "rev1");

    const report = await detectDrift(
      db,
      new ScriptedSource("docs", "rev2", { rev1: ["src/some-module/file.ts"] }),
    );

    const serialised = JSON.stringify(report);
    expect(serialised.split("src/some-module/file.ts").length - 1).toBe(1);
    expect(report.stale).toHaveLength(1);
    expect(report.stale[0]?.pages).toHaveLength(100);
  });

  test("the report grows with pages alone, not with pages times changed paths", async () => {
    const changedPaths = Array.from({ length: 50 }, (_, i) => `src/module-${i}/file-${i}.ts`);
    const sizeFor = async (pageCount: number): Promise<number> => {
      db.query("DELETE FROM pages").run();
      for (let i = 0; i < pageCount; i++) addPage(`knowledge/page-${i}.md`, "docs", "rev1");
      const report = await detectDrift(
        db,
        new ScriptedSource("docs", "rev2", { rev1: changedPaths }),
      );
      return JSON.stringify(report).length;
    };

    const small = await sizeFor(10);
    const large = await sizeFor(100);

    // The 90 extra pages may add their own path strings and nothing else. Under
    // the previous shape each one dragged all 50 changed paths along with it,
    // and this difference was more than twenty times larger.
    expect(large - small).toBeLessThan(90 * 40);
  });
});

/** A source nobody here can question: it raises instead of answering. */
class DelegatedStub implements SourceAdapter {
  constructor(
    readonly id: string,
    private readonly via = "notion",
    private readonly scope = "The Design decisions page and everything below it.",
  ) {}

  async revision(): Promise<string> {
    throw new DelegatedSourceError(this.id, this.via, this.scope);
  }
  async changedSince(): Promise<string[]> {
    throw new DelegatedSourceError(this.id, this.via, this.scope);
  }
  async locate(): Promise<LocationVerdict> {
    return { verdict: "unknown", detail: "the agent reads this" };
  }
  citation(path: string): string {
    return `${this.id}:${path}`;
  }
  pinRevision(): void {}
}

describe("a source only the agent can reach", () => {
  test("its pages become a work order, not a verdict", async () => {
    addPage("knowledge/a.md", "docs", "2026-08-01T10:22:00Z");
    addPage("knowledge/b.md", "docs", "2026-08-01T10:22:00Z");

    const report = await detectDrift(db, new DelegatedStub("docs"));

    expect(report.currentRevision).toBeNull();
    expect(report.delegated?.via).toBe("notion");
    expect(report.delegated?.guidance).toContain("Design decisions");
    expect(report.delegated?.pending).toEqual([
      { revision: "2026-08-01T10:22:00Z", pages: ["knowledge/a.md", "knowledge/b.md"] },
    ]);
  });

  test("it never lands in unresolvable", async () => {
    // `unresolvable` means the recorded revision is gone and the work starts
    // over. Nobody asked this source anything, so saying that would send a
    // reader to redo work for a reason that never happened.
    addPage("knowledge/a.md", "docs", "2026-08-01T10:22:00Z");

    const report = await detectDrift(db, new DelegatedStub("docs"));
    expect(report.unresolvable).toEqual([]);
    expect(report.stale).toEqual([]);
  });

  test("a page recording no revision is still unverifiable", async () => {
    // Independent of who can read the source: there is no revision to compare
    // against, whoever does the comparing.
    addPage("knowledge/a.md", "docs", null);

    const report = await detectDrift(db, new DelegatedStub("docs"));
    expect(report.unverifiable).toEqual(["knowledge/a.md"]);
    expect(report.delegated?.pending).toEqual([]);
  });

  test("a source nothing cites yet reports no pending work", async () => {
    const report = await detectDrift(db, new DelegatedStub("docs"));
    expect(report.delegated?.pending).toEqual([]);
    expect(report.unverifiable).toEqual([]);
  });
});

/** A scripted source that can also say what a change did to each cited range. */
class LineAwareSource extends ScriptedSource {
  readonly asked: string[] = [];

  constructor(
    id: string,
    current: string,
    changes: Record<string, string[] | "unknown">,
    private readonly lines: Record<string, Record<string, LocatorChange> | "unknown">,
  ) {
    super(id, current, changes);
  }

  async touchedSince(revision: string, path: string, locators: readonly string[]) {
    this.asked.push(`${revision} ${path} ${locators.join(",")}`);
    const answer = this.lines[`${revision} ${path}`];
    if (answer === undefined || answer === "unknown") {
      throw new UnknownRevisionError(this.id, revision);
    }
    return new Map(locators.map((l) => [l, answer[l] ?? { status: "untouched" as const }]));
  }
}

function addFootnote(
  page: string,
  footnote: string,
  revision: string,
  path: string,
  locator: string,
) {
  db.query(
    `INSERT INTO citations (page_path, footnote, line, text, source, revision, path, locator, claim)
     VALUES (?, ?, ?, '', 'docs', ?, ?, ?, '')`,
  ).run(page, footnote, footnote.length, revision, path, locator);
}

describe("detectDrift at line granularity", () => {
  test("a source that cannot diff contents reports exactly what it did before", async () => {
    addPage("knowledge/a.md", "docs", "rev1");
    addFootnote("knowledge/a.md", "x", "rev1", "ch.md", "L1-L5");
    const report = await detectDrift(db, new ScriptedSource("docs", "rev2", { rev1: ["ch.md"] }));
    expect(report.stale).toEqual([
      { revision: "rev1", changedPaths: ["ch.md"], pages: ["knowledge/a.md"] },
    ]);
  });

  test("each citation into a changed path says what the change did to it", async () => {
    for (const page of ["a", "b", "c", "d"]) addPage(`knowledge/${page}.md`, "docs", "rev1");
    addFootnote("knowledge/a.md", "x", "rev1", "ch.md", "L1-L5");
    addFootnote("knowledge/b.md", "y", "rev1", "ch.md", "L20-L30");
    addFootnote("knowledge/c.md", "z", "rev1", "ch.md", "L40");
    addFootnote("knowledge/d.md", "w", "rev1", "other.md", "L1");
    const source = new LineAwareSource(
      "docs",
      "rev2",
      { rev1: ["ch.md"] },
      {
        "rev1 ch.md": {
          "L1-L5": { status: "touched" },
          L40: { status: "moved", locator: "L42" },
        },
      },
    );
    const report = await detectDrift(db, source);
    const [entry] = report.stale;

    // Every page stays listed: untouched lines lower the doubt, they do not clear it.
    expect(entry?.pages).toHaveLength(4);
    expect(entry?.citations?.map((c) => [c.page, c.footnote, c.change.status])).toEqual([
      ["knowledge/a.md", "x", "touched"],
      ["knowledge/b.md", "y", "untouched"],
      ["knowledge/c.md", "z", "moved"],
    ]);
    expect(Object.fromEntries(pageChanges(entry!)!)).toEqual({
      "knowledge/a.md": "changed",
      "knowledge/b.md": "untouched",
      "knowledge/c.md": "moved",
      "knowledge/d.md": "uncited",
    });
    // One question per revision and path, however many pages cite it.
    expect(source.asked).toEqual(["rev1 ch.md L1-L5,L20-L30,L40"]);
  });

  test("the diff starts at the citation's own revision, whose line numbers it uses", async () => {
    addPage("knowledge/a.md", "docs", "rev1");
    addFootnote("knowledge/a.md", "x", "rev0", "ch.md", "L1");
    const source = new LineAwareSource("docs", "rev2", { rev1: ["ch.md"] }, { "rev0 ch.md": {} });
    await detectDrift(db, source);
    expect(source.asked).toEqual(["rev0 ch.md L1"]);
  });

  test("a citation revision the source cannot place is unknown, never untouched", async () => {
    addPage("knowledge/a.md", "docs", "rev1");
    addFootnote("knowledge/a.md", "x", "gone", "ch.md", "L1");
    const source = new LineAwareSource("docs", "rev2", { rev1: ["ch.md"] }, {});
    const report = await detectDrift(db, source);
    expect(report.stale[0]?.citations?.[0]?.change).toEqual({ status: "unknown" });
    expect(pageChanges(report.stale[0]!)?.get("knowledge/a.md")).toBe("changed");
  });

  test("a whole-document canonical_source into a changed document is touched", async () => {
    db.query(
      `INSERT INTO pages (path, type, title, source, canonical_source, last_verified_revision, frontmatter_json, body, mtime)
       VALUES ('knowledge/a.md', 'note', 'a', 'docs', 'docs:ch.md', 'rev1', '{}', '', 0)`,
    ).run();
    const source = new LineAwareSource("docs", "rev2", { rev1: ["ch.md"] }, {});
    const report = await detectDrift(db, source);
    expect(report.stale[0]?.citations).toEqual([
      {
        page: "knowledge/a.md",
        footnote: null,
        path: "ch.md",
        locator: null,
        change: { status: "touched" },
      },
    ]);
    expect(source.asked).toEqual([]);
  });
});
