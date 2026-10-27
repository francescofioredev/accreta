import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/main.ts";

let root = "";
let output: string[] = [];

async function cli(...argv: string[]): Promise<number> {
  return run(argv, { cwd: root, out: (line) => output.push(line), err: () => {} });
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if ((await proc.exited) !== 0) throw new Error(await new Response(proc.stderr).text());
  return (await new Response(proc.stdout).text()).trim();
}

async function gitSource(id: string): Promise<string> {
  const dir = join(root, "sources", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "doc.md"), `${id}\n`, "utf-8");
  await git(dir, "init", "-q");
  await git(dir, "config", "user.email", "t@example.invalid");
  await git(dir, "config", "user.name", "Test");
  await git(dir, "add", ".");
  await git(dir, "commit", "-qm", id);
  writeFileSync(join(root, "sources", `${id}.yaml`), `id: ${id}\ntype: git\nroot: sources/${id}\n`);
  return git(dir, "rev-parse", "HEAD");
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "accreta-foreign-rev-"));
  output = [];
  delete process.env.ACCRETA_INDEX_PATH;
  delete process.env.ACCRETA_ROOT;
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

test("lint names a last_verified_revision only another source has (#260)", async () => {
  await cli("init");
  rmSync(join(root, "sources", "example.yaml"), { force: true });
  await gitSource("a");
  const foreign = await gitSource("b");
  mkdirSync(join(root, "knowledge"), { recursive: true });
  writeFileSync(
    join(root, "knowledge", "a.md"),
    `---\ntype: note\nsource: a\ncanonical_source: "a:doc.md#L1"\nlast_verified_revision: ${foreign}\n---\n\n# A\n`,
  );
  await cli("reindex");
  output = [];

  expect(await cli("lint")).toBe(1);
  expect(output.join("\n")).toContain(
    `knowledge/a.md: source "a" cannot place last_verified_revision ${foreign}`,
  );
});
