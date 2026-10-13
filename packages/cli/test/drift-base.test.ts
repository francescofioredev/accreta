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
import { run } from "../src/main.ts";

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

describe("drift --base on source declarations that did not load", () => {
  let output: string[] = [];
  const cli = (...argv: string[]) =>
    run(argv, { cwd: root, out: (line) => output.push(line), err: () => {} });
  const writeSource = (name: string, body: string) =>
    writeFileSync(join(root, "sources", name), body, "utf-8");
  const BROKEN = "id: broken\ntype: fss\n";

  /** What the action does on the base branch: `drift --json`, kept even when it exits 1. */
  async function baseReport(): Promise<string> {
    output = [];
    await cli("drift", "--json");
    const path = join(root, "base.json");
    writeFileSync(path, output.join("\n"), "utf-8");
    output = [];
    return path;
  }

  beforeEach(async () => {
    delete process.env.ACCRETA_INDEX_PATH;
    delete process.env.ACCRETA_ROOT;
    await cli("init");
    await cli("reindex");
    output = [];
  });

  test("one already broken on the base is listed, as inherited, and passes", async () => {
    writeSource("broken.yaml", BROKEN);
    const base = await baseReport();
    // A new reason on the same file is still the same declaration.
    writeSource("broken.yaml", "id: broken\ntype: fsss\n");

    expect(await cli("drift", "--base", base)).toBe(0);
    expect(output.join("\n")).toContain("sources/broken.yaml — did not load on the base branch");

    output = [];
    expect(await cli("drift", "--json", "--base", base)).toBe(0);
    const json = JSON.parse(output.join("\n"));
    expect(json.sources_newly_unloaded).toBe(0);
    expect(json.unloaded_sources).toMatchObject([{ file: "sources/broken.yaml", on_base: true }]);

    output = [];
    expect(await cli("drift", "--format", "github", "--base", base)).toBe(0);
    const out = output.join("\n");
    const folded = out.indexOf("<details>");
    expect(folded).toBeGreaterThan(-1);
    expect(out.indexOf("`sources/broken.yaml`")).toBeGreaterThan(folded);
    expect(out).toContain("already did not load on the base branch");
  });

  test("one the change broke fails", async () => {
    writeSource("broken.yaml", "id: broken\ntype: fs\nroot: .\n");
    const base = await baseReport();
    writeSource("broken.yaml", BROKEN);

    expect(await cli("drift", "--json", "--base", base)).toBe(1);
    const json = JSON.parse(output.join("\n"));
    expect(json.sources_newly_unloaded).toBe(1);
    expect(json.unloaded_sources).toMatchObject([{ file: "sources/broken.yaml", on_base: false }]);

    output = [];
    expect(await cli("drift", "--format", "github", "--base", base)).toBe(1);
    const out = output.join("\n");
    expect(out.indexOf("- `sources/broken.yaml` did not load")).toBeLessThan(out.indexOf("**"));
    expect(out).not.toContain("<details>");
  });

  test("one added broken fails, next to one inherited", async () => {
    writeSource("broken.yaml", BROKEN);
    const base = await baseReport();
    writeSource("added.yaml", "id: added\ntype: fss\n");

    expect(await cli("drift", "--json", "--base", base)).toBe(1);
    const json = JSON.parse(output.join("\n"));
    expect(json.sources_newly_unloaded).toBe(1);
    expect(json.unloaded_sources).toMatchObject([
      { file: "sources/added.yaml", on_base: false },
      { file: "sources/broken.yaml", on_base: true },
    ]);
  });

  test("without --base, one inherited still fails", async () => {
    writeSource("broken.yaml", BROKEN);

    expect(await cli("drift")).toBe(1);
    output = [];
    expect(await cli("drift", "--json")).toBe(1);
    const json = JSON.parse(output.join("\n"));
    expect(json.sources_newly_unloaded).toBe(1);
    expect(json.unloaded_sources[0]).not.toHaveProperty("on_base");
  });

  test("a base report from before the marking is read by file", async () => {
    writeSource("broken.yaml", BROKEN);
    const base = join(root, "old-base.json");
    // As drift wrote it after #176: unloaded_sources, but no on_base and no newly count.
    const old = { pages_in_doubt: 0, pages_newly_in_doubt: 0, pages_unplaceable: 0 };
    const unloaded = [{ file: "sources/broken.yaml", id: "broken", reason: "older", pages: 0 }];
    writeFileSync(base, JSON.stringify({ ...old, sources: [], unloaded_sources: unloaded }));
    expect(await cli("drift", "--base", base)).toBe(0);

    // From before #176: no unloaded_sources at all, so nothing is inherited.
    writeFileSync(base, JSON.stringify({ ...old, sources: [] }));
    expect(await cli("drift", "--base", base)).toBe(1);
  });
});
