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
      { path: "knowledge/a.md", verifiedAt: "rev1", changedPaths: ["chapter-07.md"] },
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
    expect(report.stale.map((s) => s.path)).toEqual(["knowledge/a.md"]);
  });

  test("pages sharing a revision are diffed once and reported together", async () => {
    addPage("knowledge/a.md", "docs", "rev1");
    addPage("knowledge/b.md", "docs", "rev1");
    const report = await detectDrift(db, new ScriptedSource("docs", "rev2", { rev1: ["x.md"] }));
    expect(report.stale.map((s) => s.path)).toEqual(["knowledge/a.md", "knowledge/b.md"]);
  });
});
