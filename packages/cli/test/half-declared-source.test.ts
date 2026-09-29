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
  writeFileSync(
    join(root, "knowledge", "b.md"),
    "---\ntype: note\nsource: design-docs\nlast_verified_revision: 2026-08-01\n---\n\n# B\n",
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

  test("drift fails on it with the git source up to date, and says how much went unchecked", async () => {
    await workspace();

    expect(await cli("drift")).toBe(1);
    expect(stdout()).toContain("up to date");
    expect(stdout()).toContain("1 page(s) cite it and were not checked");
  });

  test("lint --json carries it as a finding on the file", async () => {
    await workspace();

    expect(await cli("lint", "--json")).toBe(1);
    const findings = JSON.parse(stdout()).findings as { kind: string; path: string }[];
    expect(findings.filter((f) => f.kind === "unloaded-source").map((f) => f.path)).toEqual([
      "sources/design-docs.yaml",
    ]);
  });

  test("the pull request formats carry it, so a check in CI cannot go green on it", async () => {
    await workspace();

    expect(await cli("drift", "--json")).toBe(1);
    const report = JSON.parse(stdout());
    expect(report.sources.map((s: { source_id: string }) => s.source_id)).toEqual(["docs"]);
    expect(report.unloaded_sources).toEqual([
      {
        file: "sources/design-docs.yaml",
        id: "design-docs",
        reason: expect.stringContaining("`scope`"),
        pages: 1,
      },
    ]);

    output = [];
    expect(await cli("drift", "--format", "github")).toBe(1);
    const out = stdout();
    expect(out).toContain(
      "**1 source declaration(s) did not load; pages citing them were not checked.**",
    );
    // Above the headline, so the counts-only comment keeps it.
    const line = out.indexOf("- `sources/design-docs.yaml` did not load, so 1 page(s)");
    expect(line).toBeGreaterThan(-1);
    expect(line).toBeLessThan(out.indexOf("**"));
    expect(out).toContain("No line any checked page cites has changed.");
    expect(out).toContain("`docs` at");
  });
});

describe("a declaration that cannot build at all", () => {
  test("a typo in `type` fails drift, as it did when it threw", async () => {
    await workspace();
    writeFileSync(join(root, "sources", "docs.yaml"), "id: docs\ntype: fss\nroot: sources/docs\n");

    expect(await cli("drift")).toBe(1);
    expect(stdout()).toContain("sources/docs.yaml — did not load, so 1 page(s) cite it");
    expect(stdout()).toContain('Unknown source type "fss"');
  });

  test("a page counts as citing it through a footnote or canonical_source, not only `source`", async () => {
    await workspace();
    writeFileSync(join(root, "sources", "docs.yaml"), "id: docs\ntype: fss\nroot: sources/docs\n");
    writeFileSync(
      join(root, "knowledge", "a.md"),
      "---\ntype: note\nsource: other\n---\n\n# A\n\nA claim.[^c]\n\n[^c]: docs @ abc1234 · a.md#L2\n",
    );
    writeFileSync(
      join(root, "knowledge", "c.md"),
      '---\ntype: note\ncanonical_source: "docs:a.md#L1"\n---\n\n# C\n',
    );
    await cli("reindex");
    output = [];

    expect(await cli("drift")).toBe(1);
    expect(stdout()).toContain("sources/docs.yaml — did not load, so 2 page(s) cite it");
    output = [];
    await cli("lint");
    expect(stdout()).toContain("sources/docs.yaml: did not load, so 2 page(s) cite it");
  });

  test("the github format puts the reason in a code span, whatever the declaration says", async () => {
    await workspace();
    writeFileSync(join(root, "sources", "docs.yaml"), 'id: "<img src=x>"\ntype: fss\n');

    expect(await cli("drift", "--format", "github")).toBe(1);
    expect(stdout()).toContain('`Unknown source type "fss" for source "<img src=x>".');
    expect(stdout()).not.toMatch(/[^`"]<img/);
  });

  test("doctor names a malformed file and carries on", async () => {
    await workspace();
    writeFileSync(join(root, "sources", "broken.yaml"), "type: fs\n");

    expect(await cli("doctor")).toBe(1);
    expect(stdout()).toContain("sources/broken.yaml");
    expect(stdout()).toContain("`id`");
    expect(stdout()).toContain("docs — git");
  });
});
