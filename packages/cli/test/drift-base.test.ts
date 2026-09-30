import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  detectDrift,
  openIndex,
  UnknownRevisionError,
  type DriftReport,
  type LocationVerdict,
  type SourceAdapter,
} from "@accreta/core";
import { readBase, toJson } from "../src/commands/drift.ts";

class ScriptedSource implements SourceAdapter {
  constructor(
    readonly id: string,
    private readonly current: string,
    private readonly changes: Record<string, string[]>,
  ) {}
  async revision(): Promise<string> {
    return this.current;
  }
  async changedSince(revision: string): Promise<string[]> {
    const answer = this.changes[revision];
    if (answer === undefined) throw new UnknownRevisionError(this.id, revision);
    return answer;
  }
  async touchedSince(revision: string, _path: string, locators: readonly string[]) {
    if (this.changes[revision] === undefined) throw new UnknownRevisionError(this.id, revision);
    return new Map(locators.map((l) => [l, { status: "untouched" as const }]));
  }
  async locate(): Promise<LocationVerdict> {
    return { verdict: "found" };
  }
  citation(path: string): string {
    return `${this.id}:${path}`;
  }
  pinRevision(): void {}
}

let root = "";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "accreta-drift-base-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** A `--base` from one run's report, read back as the CLI reads it. */
function asBase(reports: DriftReport[]) {
  const path = join(root, "base.json");
  writeFileSync(path, JSON.stringify(toJson(reports)), "utf-8");
  return readBase(path);
}

/** A source that can only say which files changed, naming one page at `revision`. */
function perFile(revision: string, citedOnly: boolean): DriftReport {
  return {
    sourceId: "docs",
    currentRevision: "now",
    stale: [
      {
        revision,
        changedPaths: ["note.md"],
        pages: ["knowledge/a.md"],
        ...(citedOnly
          ? { citedOnly: ["knowledge/a.md"], citedPaths: { "knowledge/a.md": ["note.md"] } }
          : {}),
      },
    ],
    unverifiable: [],
    unresolvable: [],
    delegated: null,
  };
}

describe("drift --base", () => {
  test("an unplaceable pin stays unplaceable when a change touches another file", async () => {
    const db = openIndex(join(root, "index.sqlite"));
    db.prepare(
      `INSERT INTO pages (path, type, title, source, last_verified_revision, frontmatter_json, body, mtime)
       VALUES ('knowledge/finding.md', 'note', 'f', 'noaa', 'r1', '{}', '', 0)`,
    ).run();
    db.prepare(
      `INSERT INTO citations (page_path, footnote, line, text, source, revision, path, locator, claim)
       VALUES ('knowledge/finding.md', 'old', 1, '', 'noaa', 'gone', 'y.md', 'L1', '')`,
    ).run();
    const onBase = await detectDrift(db, new ScriptedSource("noaa", "r1", {}));
    const onHead = await detectDrift(db, new ScriptedSource("noaa", "r2", { r1: ["other.md"] }));
    db.close();

    const json = toJson([onHead], asBase([onBase]));

    expect(json.sources[0]!.unresolvable).toEqual(toJson([onBase]).sources[0]!.unresolvable);
    expect(json.pages_newly_in_doubt).toBe(0);
    expect(json.pages_newly_unplaceable).toBe(0);
  });

  test("a per-file page named at its pin, then at its own revision, is not new", () => {
    const json = toJson([perFile("r1", false)], asBase([perFile("p0", true)]));

    expect(json.pages_in_doubt).toBe(1);
    expect(json.pages_newly_in_doubt).toBe(0);
  });
});
