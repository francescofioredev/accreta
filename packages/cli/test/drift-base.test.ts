import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
import { countsOnly } from "../../../scripts/drift-comment.ts";

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

  /** A page whose frontmatter names `source`, indexed. */
  async function citing(name: string, source: string) {
    const page = `---\ntype: note\nsource: ${source}\n---\n\n# ${name}\n`;
    writeFileSync(join(root, "knowledge", `${name}.md`), page, "utf-8");
    await cli("reindex");
    output = [];
  }

  /** What the action does on the base branch: `drift --json`, kept even when it exits 1. */
  async function baseReport(): Promise<string> {
    output = [];
    await cli("drift", "--json");
    const path = join(root, "base.json");
    writeFileSync(path, output.join("\n"), "utf-8");
    output = [];
    return path;
  }

  async function json(...argv: string[]) {
    output = [];
    const code = await cli("drift", "--json", ...argv);
    return { code, json: JSON.parse(output.join("\n")) };
  }

  beforeEach(async () => {
    delete process.env.ACCRETA_INDEX_PATH;
    delete process.env.ACCRETA_ROOT;
    await cli("init");
    await cli("reindex");
    output = [];
  });

  test("one already broken on the base is listed as inherited and not counted as new", async () => {
    writeSource("broken.yaml", BROKEN);
    const base = await baseReport();
    // A new reason on the same file is still the same declaration.
    writeSource("broken.yaml", "id: broken\ntype: fsss\n");

    expect(await cli("drift", "--base", base)).toBe(0);
    expect(output.join("\n")).toContain("sources/broken.yaml — did not load on the base branch");

    const { json: report } = await json("--base", base);
    expect(report.sources_newly_unloaded).toBe(0);
    expect(report.unloaded_sources).toMatchObject([{ file: "sources/broken.yaml", on_base: true }]);

    output = [];
    await cli("drift", "--format", "github", "--base", base);
    const out = output.join("\n");
    const folded = out.indexOf("<details>");
    expect(folded).toBeGreaterThan(-1);
    expect(out.indexOf("`sources/broken.yaml`")).toBeGreaterThan(folded);
    expect(out).toContain("already did not load on the base branch");
    // GitHub's fallback comment keeps only the headline: it must still say so.
    expect(countsOnly(out)).toContain(
      "**1 source declaration(s) still do not load, as on the base branch;",
    );
  });

  test("one the change broke is new", async () => {
    writeSource("broken.yaml", "id: broken\ntype: fs\nroot: .\n");
    const base = await baseReport();
    writeSource("broken.yaml", BROKEN);

    const { code, json: report } = await json("--base", base);
    expect(code).toBe(1);
    expect(report.sources_newly_unloaded).toBe(1);
    expect(report.unloaded_sources).toMatchObject([
      { file: "sources/broken.yaml", on_base: false },
    ]);

    output = [];
    await cli("drift", "--format", "github", "--base", base);
    const out = output.join("\n");
    expect(out.indexOf("- `sources/broken.yaml` did not load")).toBeLessThan(out.indexOf("**"));
    expect(out).toContain("did not load because of this change");
    expect(out).not.toContain("<details>");
  });

  test("one added broken is new, next to one inherited", async () => {
    writeSource("broken.yaml", BROKEN);
    const base = await baseReport();
    writeSource("added.yaml", "id: added\ntype: fss\n");

    const { json: report } = await json("--base", base);
    expect(report.sources_newly_unloaded).toBe(1);
    expect(report.unloaded_sources).toMatchObject([
      { file: "sources/added.yaml", on_base: false },
      { file: "sources/broken.yaml", on_base: true },
    ]);
  });

  test("an inherited one is new once more pages cite it", async () => {
    writeSource("broken.yaml", BROKEN);
    const base = await baseReport();
    await citing("a", "broken");

    const { json: report } = await json("--base", base);
    expect(report.sources_newly_unloaded).toBe(1);
    expect(report.unloaded_sources).toMatchObject([{ pages: 1, on_base: false }]);
  });

  test("an inherited file is new when its id changed", async () => {
    writeSource("broken.yaml", BROKEN);
    const base = await baseReport();
    writeSource("broken.yaml", "id: renamed\ntype: fss\n");

    const { json: report } = await json("--base", base);
    expect(report.sources_newly_unloaded).toBe(1);
  });

  test("without --base, one inherited still fails", async () => {
    writeSource("broken.yaml", BROKEN);

    expect(await cli("drift")).toBe(1);
    const { code, json: report } = await json();
    expect(code).toBe(1);
    expect(report.sources_newly_unloaded).toBe(1);
    expect(report.unloaded_sources[0]).not.toHaveProperty("on_base");
  });

  test("a base report from before the marking is read by file, id and pages", async () => {
    writeSource("broken.yaml", BROKEN);
    const base = join(root, "old-base.json");
    // As drift wrote it after #176: unloaded_sources, but no on_base and no newly count.
    const old = { pages_in_doubt: 0, pages_newly_in_doubt: 0, pages_unplaceable: 0 };
    const unloaded = [{ file: "sources/broken.yaml", id: "broken", reason: "older", pages: 0 }];
    writeFileSync(base, JSON.stringify({ ...old, sources: [], unloaded_sources: unloaded }));
    expect((await json("--base", base)).json.sources_newly_unloaded).toBe(0);

    // From before #176: no unloaded_sources at all, so nothing is inherited.
    writeFileSync(base, JSON.stringify({ ...old, sources: [] }));
    expect((await json("--base", base)).json.sources_newly_unloaded).toBe(1);
  });
});

const twentyLines = (edit: Record<number, string> = {}) =>
  Array.from({ length: 20 }, (_, i) => edit[i + 1] ?? `line ${i + 1}`).join("\n") + "\n";

describe("drift --base exits 1 only on what the change put in doubt", () => {
  let output: string[] = [];
  const cli = (...argv: string[]) =>
    run(argv, { cwd: root, out: (line) => output.push(line), err: () => {} });
  const docs = () => join(root, "sources", "docs");
  const git = (...args: string[]) => {
    const proc = Bun.spawnSync(["git", ...args], { cwd: docs() });
    if (proc.exitCode !== 0) throw new Error(proc.stderr.toString());
    return proc.stdout.toString().trim();
  };
  const UNKNOWN = "0123456789abcdef0123456789abcdef01234567";
  let first = "";

  const page = (name: string, frontmatter: string, body = "") =>
    writeFileSync(
      join(root, "knowledge", `${name}.md`),
      `---\ntype: note\n${frontmatter}---\n\n# ${name}\n${body}`,
      "utf-8",
    );
  /** A page verified at the first commit, citing `locator` of `a.md`. */
  const citing = (name: string, locator: string) =>
    page(
      name,
      `source: docs\nlast_verified_revision: ${first}\n`,
      `\nA claim.[^c]\n\n[^c]: docs @ ${first.slice(0, 7)} · a.md#${locator}\n`,
    );
  const delegated = (name: string, revision: string) =>
    page(name, `source: design-docs\nlast_verified_revision: ${revision}\n`);

  /** What the action does on the base branch: `drift --json`, kept even when it exits 1. */
  async function baseReport(): Promise<string> {
    await cli("reindex");
    output = [];
    await cli("drift", "--json");
    const path = join(root, "base.json");
    writeFileSync(path, output.join("\n"), "utf-8");
    return path;
  }

  async function drift(...argv: string[]): Promise<number> {
    await cli("reindex");
    output = [];
    return cli("drift", ...argv);
  }

  beforeEach(async () => {
    delete process.env.ACCRETA_INDEX_PATH;
    delete process.env.ACCRETA_ROOT;
    await cli("init");
    rmSync(join(root, "sources", "example.yaml"), { force: true });
    mkdirSync(docs(), { recursive: true });
    writeFileSync(join(docs(), "a.md"), twentyLines(), "utf-8");
    git("init", "-q");
    git("config", "user.email", "t@example.invalid");
    git("config", "user.name", "Test");
    git("add", ".");
    git("commit", "-qm", "first");
    first = git("rev-parse", "HEAD");
    writeFileSync(join(root, "sources", "docs.yaml"), "id: docs\ntype: git\nroot: sources/docs\n");
    writeFileSync(
      join(root, "sources", "design-docs.yaml"),
      "id: design-docs\ntype: delegated\nvia: notion\nscope: The Design decisions page.\n",
    );
  });

  test("a page already in doubt on the base passes, without --base it still fails", async () => {
    citing("changed", "L3-L5");
    writeFileSync(join(docs(), "a.md"), twentyLines({ 4: "rewritten" }), "utf-8");
    git("commit", "-qam", "second");
    const base = await baseReport();

    expect(await drift("--base", base)).toBe(0);
    expect(await drift()).toBe(1);
  });

  test("a page the change put in doubt fails, and --json counts it", async () => {
    citing("changed", "L3-L5");
    const base = await baseReport();
    writeFileSync(join(docs(), "a.md"), twentyLines({ 4: "rewritten" }), "utf-8");
    git("commit", "-qam", "second");

    expect(await drift("--json", "--base", base)).toBe(1);
    expect(JSON.parse(output.join("\n")).pages_newly_in_doubt).toBe(1);
  });

  test("a page already unplaceable on the base passes; one newly unplaceable fails", async () => {
    page("lost", `source: docs\nlast_verified_revision: ${UNKNOWN}\n`);
    const base = await baseReport();

    expect(await drift("--base", base)).toBe(0);
    expect(await drift()).toBe(1);

    page("also-lost", `source: docs\nlast_verified_revision: ${UNKNOWN}\n`);
    expect(await drift("--json", "--base", base)).toBe(1);
    expect(JSON.parse(output.join("\n")).pages_newly_unplaceable).toBe(1);
  });

  test("under --strict, a page already unverifiable passes; a new one fails", async () => {
    page("bare", "source: docs\n");
    const base = await baseReport();

    expect(await drift("--strict", "--base", base)).toBe(0);
    expect(await drift("--strict")).toBe(1);

    page("also-bare", "source: docs\n");
    expect(await drift("--strict", "--base", base)).toBe(1);
    expect(await drift("--base", base)).toBe(0);
  });

  test("under --strict, a delegated page already pending passes; a new one fails", async () => {
    delegated("design", "2026-08-01T10:22:00Z");
    const base = await baseReport();

    expect(await drift("--strict", "--base", base)).toBe(0);
    expect(await drift("--strict")).toBe(1);
    // Re-verified through the connector: the same page, so no new work is left undone.
    delegated("design", "2026-09-01T08:00:00Z");
    expect(await drift("--strict", "--base", base)).toBe(0);

    delegated("another", "2026-09-01T08:00:00Z");
    expect(await drift("--strict", "--base", base)).toBe(1);
    expect(await drift("--base", base)).toBe(0);
  });
});
