import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chooseBase } from "../scripts/drift-base.ts";

let dir = "";

function git(...args: string[]): string {
  const proc = Bun.spawnSync(["git", ...args], { cwd: dir });
  if (proc.exitCode !== 0) throw new Error(proc.stderr.toString());
  return proc.stdout.toString().trim();
}

function commit(file: string, text: string): string {
  writeFileSync(join(dir, file), text, "utf-8");
  git("add", ".");
  git("commit", "-qm", `${file}: ${text}`);
  return git("rev-parse", "HEAD");
}

/** main: m0 → m1. The pull request branches at m0, commits p1, then merges main as p2. */
function history() {
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.invalid");
  git("config", "user.name", "Test");
  commit("a.md", "m0");
  git("switch", "-qc", "pr");
  commit("b.md", "p1");
  git("switch", "-q", "main");
  const m1 = commit("c.md", "m1");
  git("switch", "-q", "pr");
  git("merge", "-q", "--no-edit", "main");
  const p2 = git("rev-parse", "HEAD");
  return { m1, p2 };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "accreta-drift-base-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

test("a pull request head that merged main compares with the merge base, not HEAD^1", async () => {
  const { m1, p2 } = history();
  expect(git("rev-parse", "HEAD^1")).not.toBe(m1);
  expect(await chooseBase(dir, { head: p2, base: m1 })).toEqual({ kind: "base", revision: m1 });
});

test("GitHub's test merge compares with its first parent", async () => {
  const { m1, p2 } = history();
  git("switch", "-q", "--detach", "main");
  git("merge", "-q", "--no-ff", "--no-edit", p2);
  expect(await chooseBase(dir, { head: p2, base: m1 })).toEqual({ kind: "base", revision: m1 });
});

test("any other checkout is not compared", async () => {
  const { m1, p2 } = history();
  git("switch", "-q", "main");
  expect((await chooseBase(dir, { head: p2, base: m1 })).kind).toBe("none");
  expect((await chooseBase(dir, {})).kind).toBe("none");
});

test("a shallow clone is reported, not compared", async () => {
  history();
  const source = dir;
  dir = mkdtempSync(join(tmpdir(), "accreta-drift-shallow-"));
  git("clone", "-q", "--depth", "1", `file://${source}`, ".");
  expect(await chooseBase(dir, { head: "x", base: "y" })).toEqual({ kind: "shallow" });
  rmSync(source, { recursive: true, force: true });
});
