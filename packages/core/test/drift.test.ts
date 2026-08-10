import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectDrift } from "../src/source/drift.ts";
import { UnknownRevisionError, type LineRange, type SourceAdapter } from "../src/source/adapter.ts";
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

  async read(): Promise<string> {
    return "";
  }

  citation(path: string, lines?: LineRange): string {
    return lines ? `${this.id}:${path}#${lines[0]}` : `${this.id}:${path}`;
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
