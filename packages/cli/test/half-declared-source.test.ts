import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/main.ts";

let root = "";
let output: string[] = [];

async function cli(...argv: string[]): Promise<number> {
  return run(argv, { cwd: root, out: (line) => output.push(line), err: () => {} });
}

const stdout = () => output.join("\n");

async function git(cwd: string, ...args: string[]): Promise<string> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if ((await proc.exited) !== 0) throw new Error(await new Response(proc.stderr).text());
  return (await new Response(proc.stdout).text()).trim();
}

/** A git source with one cited page, next to what `source add delegated` writes before `scope`. */
async function workspace(): Promise<{ docs: string; revision: string }> {
  await cli("init");
  rmSync(join(root, "sources", "example.yaml"), { force: true });

  const docs = join(root, "sources", "docs");
  mkdirSync(docs, { recursive: true });
  writeFileSync(join(docs, "a.md"), "one\ntwo\nthree\n", "utf-8");
  await git(docs, "init", "-q");
  await git(docs, "config", "user.email", "t@example.invalid");
  await git(docs, "config", "user.name", "Test");
  await git(docs, "add", ".");
  await git(docs, "commit", "-qm", "first");
  const revision = await git(docs, "rev-parse", "HEAD");

  writeFileSync(join(root, "sources", "docs.yaml"), "id: docs\ntype: git\nroot: sources/docs\n");
  writeFileSync(
    join(root, "sources", "design-docs.yaml"),
    "id: design-docs\ntype: delegated\nvia: notion\nscope: |\n",
  );
  mkdirSync(join(root, "knowledge"), { recursive: true });
  writeFileSync(
    join(root, "knowledge", "a.md"),
    `---\ntype: note\nsource: docs\nlast_verified_revision: ${revision}\n---\n\n# A\n\n` +
      `A claim.[^c]\n\n[^c]: docs @ ${revision.slice(0, 7)} · a.md#L2\n`,
  );
  await cli("reindex");
  output = [];
  return { docs, revision };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "accreta-half-declared-"));
  output = [];
  delete process.env.ACCRETA_INDEX_PATH;
  delete process.env.ACCRETA_ROOT;
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("one delegated source still missing its scope, next to a git source", () => {
  test("lint checks the git source and names the file to fix", async () => {
    await workspace();

    expect(await cli("lint")).toBe(1);
    expect(stdout()).toContain("1 citation(s) checked against their source.");
    expect(stdout()).toContain("sources/design-docs.yaml");
    expect(stdout()).toContain("`scope`");
  });

  test("drift checks the git source and names the file to fix", async () => {
    const { docs } = await workspace();
    writeFileSync(join(docs, "a.md"), "one\nchanged\nthree\n", "utf-8");
    await git(docs, "commit", "-qam", "second");

    expect(await cli("drift")).toBe(1);
    expect(stdout()).toContain("1 page(s) may have drifted");
    expect(stdout()).toContain("sources/design-docs.yaml");
    expect(stdout()).toContain("`scope`");
  });

  test("drift passes on it, and --strict fails on it", async () => {
    await workspace();

    expect(await cli("drift")).toBe(0);
    expect(stdout()).toContain("up to date");
    expect(await cli("drift", "--strict")).toBe(1);
  });

  test("the pull request formats carry it too, so a check in CI does not drop it", async () => {
    await workspace();

    expect(await cli("drift", "--json")).toBe(0);
    const report = JSON.parse(stdout());
    expect(report.sources.map((s: { source_id: string }) => s.source_id)).toEqual(["docs"]);
    expect(report.unloaded_sources).toEqual([
      { file: "sources/design-docs.yaml", reason: expect.stringContaining("`scope`") },
    ]);

    output = [];
    expect(await cli("drift", "--format", "github")).toBe(0);
    expect(stdout()).toContain("`docs` at");
    expect(stdout()).toContain("`sources/design-docs.yaml` was not loaded");
  });
});
