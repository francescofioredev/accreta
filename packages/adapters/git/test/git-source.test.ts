import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UnknownRevisionError } from "@accreta/core";
import { GitSource } from "../src/index.ts";

let root = "";

async function run(args: string[]): Promise<void> {
  const proc = Bun.spawn(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
  const code = await proc.exited;
  if (code !== 0)
    throw new Error(`git ${args.join(" ")} failed: ${await new Response(proc.stderr).text()}`);
}

function write(relativePath: string, contents: string): void {
  const full = join(root, relativePath);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, contents, "utf-8");
}

async function commit(message: string): Promise<void> {
  await run(["add", "-A"]);
  await run(["commit", "-q", "-m", message]);
}

function source() {
  return new GitSource({
    id: "repo",
    root,
    citationFormat: "{source} @ {rev} · {path}#{locator}",
  });
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "accreta-git-"));
  await run(["init", "-q", "-b", "main"]);
  await run(["config", "user.email", "test@example.com"]);
  await run(["config", "user.name", "Test"]);
  await run(["config", "commit.gpgsign", "false"]);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("GitSource", () => {
  test("a revision is the commit SHA at HEAD", async () => {
    write("a.md", "one");
    await commit("first");

    const revision = await source().revision();
    expect(revision).toMatch(/^[0-9a-f]{40}$/);
  });

  test("a revision changes with each commit", async () => {
    write("a.md", "one");
    await commit("first");
    const first = await source().revision();

    write("a.md", "two");
    await commit("second");
    expect(await source().revision()).not.toBe(first);
  });

  test("changedSince names the files a commit touched", async () => {
    write("a.md", "one");
    write("b.md", "two");
    await commit("first");
    const first = await source().revision();

    write("b.md", "changed");
    await commit("second");
    expect(await source().changedSince(first)).toEqual(["b.md"]);
  });

  test("changedSince reports additions and deletions", async () => {
    write("a.md", "one");
    await commit("first");
    const first = await source().revision();

    write("b.md", "new");
    rmSync(join(root, "a.md"));
    await commit("second");
    expect(await source().changedSince(first)).toEqual(["a.md", "b.md"]);
  });

  test("an unchanged repository reports nothing changed", async () => {
    write("a.md", "one");
    await commit("first");
    const first = await source().revision();
    expect(await source().changedSince(first)).toEqual([]);
  });

  test("a revision this repository never had is reported, not answered", async () => {
    // A rewritten history, a shallow clone, or a revision from another
    // repository all arrive here. Answering "nothing changed" would be a claim
    // drift detection has no way to catch.
    write("a.md", "one");
    await commit("first");
    expect(source().changedSince("0".repeat(40))).rejects.toThrow(UnknownRevisionError);
  });

  test("knowsRevision says whether a citation's revision is in the history", async () => {
    write("a.md", "one");
    await commit("first");
    const git = source();
    const head = await git.revision();
    expect(await git.knowsRevision(head)).toBe(true);
    expect(await git.knowsRevision(head.slice(0, 7))).toBe(true);
    expect(await git.knowsRevision("0".repeat(40))).toBe(false);
    expect(await git.knowsRevision("not-a-revision")).toBe(false);
  });

  test("locate answers from the working tree", async () => {
    write("docs/a.md", "hello");
    await commit("first");
    expect(await source().locate("docs/a.md", "L1")).toEqual({ verdict: "found" });
    expect(await source().locate("docs/gone.md")).toMatchObject({
      verdict: "missing",
      part: "path",
    });
  });

  test("a citation pins the revision it was verified against", async () => {
    write("a.md", "one");
    await commit("first");
    const git = source();
    const first = await git.revision();

    write("a.md", "two");
    await commit("second");

    // A citation must name the revision the claim was checked against, not
    // whatever HEAD happens to be when the page is rendered later.
    git.pinRevision(first);
    expect(git.citation("a.md", "L1-L3")).toContain(first);
  });
});

describe("GitSource scoped to paths", () => {
  function scoped(paths: string[]) {
    return new GitSource({
      id: "repo",
      root,
      citationFormat: "{source} @ {rev} · {path}",
      paths,
    });
  }

  beforeEach(async () => {
    write("docs/a.md", "one");
    write("other/b.md", "two");
    await commit("first");
  });

  test("a commit outside the scoped paths does not move the revision", async () => {
    // The false positive this exists to prevent: without scoping, a source is
    // the whole repository, and a commit to an unrelated file drifts every page.
    const scopedSource = scoped(["docs"]);
    const before = await scopedSource.revision();

    write("other/b.md", "changed");
    await commit("touches only other/");

    expect(await scopedSource.revision()).toBe(before);
    expect(await scopedSource.changedSince(before)).toEqual([]);
  });

  test("a commit inside the scoped paths does move it", async () => {
    const scopedSource = scoped(["docs"]);
    const before = await scopedSource.revision();

    write("docs/a.md", "changed");
    await commit("touches docs/");

    expect(await scopedSource.revision()).not.toBe(before);
    expect(await scopedSource.changedSince(before)).toEqual(["docs/a.md"]);
  });

  test("changedSince reports only paths inside the scope", async () => {
    const scopedSource = scoped(["docs"]);
    const before = await scopedSource.revision();

    write("docs/a.md", "changed");
    write("other/b.md", "also changed");
    await commit("touches both");

    expect(await scopedSource.changedSince(before)).toEqual(["docs/a.md"]);
  });

  test("without paths the source is the whole repository", async () => {
    const wholeRepo = new GitSource({ id: "repo", root, citationFormat: "x" });
    const before = await wholeRepo.revision();

    write("other/b.md", "changed");
    await commit("anything");

    expect(await wholeRepo.revision()).not.toBe(before);
  });

  test("paths that have no commits yet resolve to HEAD rather than failing", async () => {
    const scopedSource = scoped(["nothing/here"]);
    expect(await scopedSource.revision()).toMatch(/^[0-9a-f]{40}$/);
  });
});

const lines = (n: number, edit: Record<number, string> = {}) =>
  Array.from({ length: n }, (_, i) => edit[i + 1] ?? `line ${i + 1}`).join("\n") + "\n";

describe("GitSource.touchedSince", () => {
  async function after(change: () => void, locators: string[]) {
    write("doc.md", lines(20));
    await commit("first");
    const git = source();
    const from = await git.revision();
    change();
    await commit("second");
    return Object.fromEntries(await git.touchedSince(from, "doc.md", locators));
  }

  test("an edit inside a range touches it, one beside it does not", async () => {
    const result = await after(
      () => write("doc.md", lines(20, { 8: "changed" })),
      ["L5-L10", "L11-L15", "L1-L7"],
    );
    expect(result).toEqual({
      "L5-L10": { status: "touched" },
      "L11-L15": { status: "untouched" },
      "L1-L7": { status: "untouched" },
    });
  });

  test("an edit across a range's boundary touches it", async () => {
    const result = await after(
      () => write("doc.md", lines(20, { 10: "changed", 11: "changed" })),
      ["L5-L10", "L11-L12"],
    );
    expect(result).toEqual({ "L5-L10": { status: "touched" }, "L11-L12": { status: "touched" } });
  });

  test("lines inserted above a range move it without touching it", async () => {
    const result = await after(
      () => write("doc.md", "new a\nnew b\n" + lines(20)),
      ["L5-L10", "L7"],
    );
    expect(result).toEqual({
      "L5-L10": { status: "moved", locator: "L7-L12" },
      L7: { status: "moved", locator: "L9" },
    });
  });

  const insertAfter = (n: number) => () => {
    const all = lines(20).split("\n");
    all.splice(n, 0, "inserted");
    write("doc.md", all.join("\n"));
  };

  test("lines inserted inside a range touch it", async () => {
    expect(await after(insertAfter(7), ["L5-L10"])).toEqual({ "L5-L10": { status: "touched" } });
  });

  test("lines inserted right after a range leave it untouched", async () => {
    expect(await after(insertAfter(10), ["L5-L10"])).toEqual({
      "L5-L10": { status: "untouched" },
    });
  });

  test("a deleted file touches every range, a non-line locator cannot be judged", async () => {
    const result = await after(() => rmSync(join(root, "doc.md")), ["L1-L2", "block-a1"]);
    expect(result).toEqual({ "L1-L2": { status: "touched" }, "block-a1": { status: "unknown" } });
  });

  test("a revision the repository never had is reported, not answered", async () => {
    write("doc.md", lines(3));
    await commit("first");
    expect(source().touchedSince("0".repeat(40), "doc.md", ["L1"])).rejects.toThrow(
      UnknownRevisionError,
    );
  });
});
