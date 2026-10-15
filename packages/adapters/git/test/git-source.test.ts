import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildIndex,
  DEFAULT_CONFIG,
  detectDrift,
  lintCitations,
  openIndex,
  pageChanges,
  UnknownRevisionError,
} from "@accreta/core";
import { GitCommandError, GitSource, TimeoutError } from "../src/index.ts";

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

  test("locate cannot vouch for a file with uncommitted lines", async () => {
    write("a.md", "one\ntwo\nthree");
    await commit("first");
    write("a.md", "one\ntwo\nthree\nfour\nfive\nsix");

    // HEAD has no line 5, so `found` here would pin a revision that never held it.
    expect(await source().locate("a.md", "L5-L6")).toEqual({
      verdict: "unknown",
      detail: "uncommitted changes: no commit holds what is on disk",
    });
  });

  test("locate cannot vouch for an untracked file either", async () => {
    write("a.md", "one");
    await commit("first");
    write("new.md", "fresh");

    expect(await source().locate("new.md", "L1")).toMatchObject({ verdict: "unknown" });
    expect(await source().locate("a.md", "L1")).toEqual({ verdict: "found" });
  });

  test("locates issued together share one status and still answer each path", async () => {
    write("a.md", "one");
    write("b.md", "one");
    await commit("first");
    write("b.md", "one\ntwo");
    const git = source();

    const [a, b] = await Promise.all([git.locate("a.md", "L1"), git.locate("b.md", "L1")]);
    expect(a).toEqual({ verdict: "found" });
    expect(b).toMatchObject({ verdict: "unknown" });
  });

  test("a source rooted below the repository top still sees its dirty files", async () => {
    write("docs/a.md", "one");
    write("docs/b.md", "one");
    await commit("first");
    write("docs/b.md", "one\ntwo");
    const docs = new GitSource({ id: "docs", root: join(root, "docs"), citationFormat: "{path}" });

    expect(await docs.locate("a.md", "L1")).toEqual({ verdict: "found" });
    expect(await docs.locate("b.md", "L1")).toMatchObject({ verdict: "unknown" });
  });

  test("a tracked file that matches .gitignore is still found", async () => {
    write("a.md", "one");
    await commit("first");
    write(".gitignore", "a.md\n");
    await commit("ignore it");

    expect(await source().locate("a.md", "L1")).toEqual({ verdict: "found" });
  });

  test("a file inside a submodule is unknown: the superproject's commits hold only a pointer", async () => {
    const inner = mkdtempSync(join(tmpdir(), "accreta-git-inner-"));
    try {
      const sub = (args: string[]) => Bun.spawnSync(["git", ...args], { cwd: inner });
      sub(["init", "-q", "-b", "main"]);
      writeFileSync(join(inner, "f.md"), "x\n");
      sub(["add", "-A"]);
      sub(["-c", "user.email=t@e", "-c", "user.name=T", "commit", "-q", "-m", "inner"]);
      write("top.md", "y");
      await run(["-c", "protocol.file.allow=always", "submodule", "add", "-q", inner, "sub"]);
      await commit("with submodule");

      expect(await source().locate("sub/f.md", "L1")).toMatchObject({ verdict: "unknown" });
      expect(await source().locate("top.md", "L1")).toEqual({ verdict: "found" });
    } finally {
      rmSync(inner, { recursive: true, force: true });
    }
  });

  test("locate never rewrites .git/index, so a user's own commit cannot hit index.lock", async () => {
    write("a.md", "one");
    await commit("first");
    // A newer mtime with the same content makes a locking `git status` refresh and rewrite the index.
    utimesSync(join(root, "a.md"), new Date(Date.now() + 60_000), new Date(Date.now() + 60_000));
    const before = statSync(join(root, ".git", "index")).mtimeMs;

    expect(await source().locate("a.md", "L1")).toEqual({ verdict: "found" });
    expect(statSync(join(root, ".git", "index")).mtimeMs).toBe(before);
  });

  test("a root that is not a repository is the source failing, not a delegated one", async () => {
    const plain = mkdtempSync(join(tmpdir(), "accreta-not-git-"));
    try {
      writeFileSync(join(plain, "a.md"), "one\n");
      const verdict = await new GitSource({
        id: "x",
        root: plain,
        citationFormat: "{path}",
      }).locate("a.md", "L1");
      expect(verdict).toMatchObject({ verdict: "unknown" });
      expect(verdict.verdict === "unknown" && verdict.detail).toStartWith(
        "git refused the repository: ",
      );
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });

  test("a failing git command rejects with its exit code and stderr", async () => {
    const plain = mkdtempSync(join(tmpdir(), "accreta-not-git-"));
    try {
      const failure = await new GitSource({ id: "x", root: plain, citationFormat: "{path}" })
        .revision()
        .catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(GitCommandError);
      expect(failure).toMatchObject({ exitCode: 128 });
      expect((failure as GitCommandError).stderr).toContain("not a git repository");
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });

  test("git that cannot start is not reported as git refusing the repository", async () => {
    write("a.md", "one");
    await commit("first");
    const path = process.env.PATH;
    process.env.PATH = join(root, "no-git-here");
    try {
      const verdict = await source().locate("a.md", "L1");
      expect(verdict.verdict === "unknown" && verdict.detail).toStartWith("git could not run: ");
    } finally {
      process.env.PATH = path;
    }
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

  test("locate reads a declared path however it is spelled", async () => {
    for (const paths of [["docs"], ["./docs/"], ["docs/a.md"], ["."]]) {
      expect(await scoped(paths).locate("docs/a.md")).toEqual({ verdict: "found" });
    }
    expect(await scoped(["doc"]).locate("docs/a.md")).toMatchObject({
      verdict: "missing",
      part: "path",
    });
  });

  test("locate matches a pattern in the scope the way revision() does", async () => {
    write("other/b.md", "b1\nb2\n");
    write("third/c.md", "c1\n");
    await commit("more");
    const mixed = scoped(["docs", "other/*.md"]);

    expect(await mixed.locate("docs/a.md")).toEqual({ verdict: "found" });
    expect(await mixed.locate("other/b.md", "L2")).toEqual({ verdict: "found" });
    for (const [path, locator, part] of [
      ["docs/nope.md", undefined, "path"],
      ["third/c.md", undefined, "path"],
      ["docs/a.md", "L99", "locator"],
    ] as const) {
      expect(await mixed.locate(path, locator)).toMatchObject({ verdict: "missing", part });
    }
  });

  test("a path with a NUL is refused alone, not with every locate batched beside it", async () => {
    const whole = new GitSource({ id: "repo", root, citationFormat: "x" });
    const [good, bad] = await Promise.all([
      whole.locate("docs/a.md", "L1"),
      whole.locate("other/b\0x.md", "L1"),
    ]);
    expect(good).toEqual({ verdict: "found" });
    expect(bad).toMatchObject({ verdict: "missing", part: "path" });
  });

  test("paths that have no commits yet resolve to HEAD rather than failing", async () => {
    const scopedSource = scoped(["nothing/here"]);
    expect(await scopedSource.revision()).toMatch(/^[0-9a-f]{40}$/);
  });
});

const lines = (n: number, edit: Record<number, string> = {}) =>
  Array.from({ length: n }, (_, i) => edit[i + 1] ?? `line ${i + 1}`).join("\n") + "\n";

/** About 1.4 MB, so a diff that rewrites every line is over 2 MiB. */
const big = (tag: string) =>
  Array.from({ length: 40_000 }, (_, i) => `${tag} line ${i + 1} ${"x".repeat(20)}`).join("\n");

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

  // execFile's default maxBuffer is 1 MiB; past it the diff would be an error, not hunks.
  test("a diff over 1 MiB is read whole", async () => {
    write("big.md", big("old"));
    await commit("first");
    const git = source();
    const from = await git.revision();
    write("big.md", big("new"));
    await commit("second");

    const result = await git.touchedSince(from, "big.md", ["L39999-L40000"]);
    expect(Object.fromEntries(result)).toEqual({ "L39999-L40000": { status: "touched" } });
  });

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

  test("a file git diffs as binary is still read line by line", async () => {
    write(".gitattributes", "doc.md -diff\n");
    const result = await after(
      () => write("doc.md", lines(20, { 6: "changed" })),
      ["L5-L8", "L10-L12"],
    );
    expect(result).toEqual({ "L5-L8": { status: "touched" }, "L10-L12": { status: "untouched" } });
  });

  test("a NUL byte does not hide an edit", async () => {
    const result = await after(
      () => write("doc.md", lines(20, { 1: "a\0b", 6: "changed" })),
      ["L5-L8", "L10-L12"],
    );
    expect(result["L5-L8"]).toEqual({ status: "touched" });
  });

  test("a textconv driver does not renumber the lines being judged", async () => {
    write(".gitattributes", "doc.md diff=drop\n");
    await run(["config", "diff.drop.textconv", "sed 1d"]);
    const result = await after(() => write("doc.md", lines(20, { 5: "changed" })), ["L5"]);
    expect(result).toEqual({ L5: { status: "touched" } });
  });

  test("diff.interHunkContext does not merge an untouched range into a hunk", async () => {
    await run(["config", "diff.interHunkContext", "10"]);
    const result = await after(
      () => write("doc.md", lines(20, { 3: "changed", 9: "changed" })),
      ["L5-L6"],
    );
    expect(result).toEqual({ "L5-L6": { status: "untouched" } });
  });

  test("diff.algorithm does not change which lines a hunk touches", async () => {
    await run(["config", "diff.algorithm", "patience"]);
    const original = ["x", "", "z", "", "}", "", "z", "x", "z", ""];
    const edited = ["x", "", "z", "", "", "z", "x", "}", "z", ""];
    write("doc.md", original.join("\n") + "\n");
    await commit("first");
    const from = await source().revision();
    write("doc.md", edited.join("\n") + "\n");
    await commit("second");
    // Myers deletes line 5; patience keeps it and reports it moved to L8.
    expect(Object.fromEntries(await source().touchedSince(from, "doc.md", ["L5"]))).toEqual({
      L5: { status: "touched" },
    });
  });

  test("GIT_DIFF_OPTS does not widen the hunks over untouched lines", async () => {
    const saved = process.env.GIT_DIFF_OPTS;
    process.env.GIT_DIFF_OPTS = "-u3";
    try {
      const result = await after(() => write("doc.md", lines(20, { 8: "changed" })), ["L5-L6"]);
      expect(result).toEqual({ "L5-L6": { status: "untouched" } });
    } finally {
      if (saved === undefined) delete process.env.GIT_DIFF_OPTS;
      else process.env.GIT_DIFF_OPTS = saved;
    }
  });

  test("a path is not read as a glob", async () => {
    write("app/[slug]/page.md", lines(20));
    write("app/s/page.md", lines(20));
    await commit("first");
    const from = await source().revision();
    write("app/s/page.md", "new a\nnew b\n" + lines(20));
    await commit("second");
    const result = await source().touchedSince(from, "app/[slug]/page.md", ["L8-L9"]);
    expect(Object.fromEntries(result)).toEqual({ "L8-L9": { status: "untouched" } });
  });

  test("no diff is run when no locator is a line range", async () => {
    write("doc.md", lines(3));
    await commit("first");
    const from = await source().revision();
    // A path git refuses to diff proves the diff was skipped rather than answered.
    const result = await source().touchedSince(from, "../outside.md", ["block-a1"]);
    expect(Object.fromEntries(result)).toEqual({ "block-a1": { status: "unknown" } });
  });
});

describe("GitSource renames", () => {
  test("changedSince names a renamed file under its old path too", async () => {
    write("docs/a.md", lines(12));
    await commit("first");
    const from = await source().revision();
    await run(["mv", "docs/a.md", "docs/a2.md"]);
    await commit("rename");
    expect(await source().changedSince(from)).toEqual(["docs/a.md", "docs/a2.md"]);
  });

  test("diff.renames=copies in the user's config does not pair the rename back up", async () => {
    write("docs/a.md", lines(12));
    await commit("first");
    const from = await source().revision();
    await run(["config", "diff.renames", "copies"]);
    await run(["mv", "docs/a.md", "docs/a2.md"]);
    await commit("rename");
    expect(await source().changedSince(from)).toContain("docs/a.md");
  });

  test("changedSince does not quote a non-ASCII path", async () => {
    write("docs/café.md", lines(12));
    await commit("first");
    const from = await source().revision();
    write("docs/café.md", lines(12, { 3: "changed" }));
    await commit("edit");
    expect(await source().changedSince(from)).toEqual(["docs/café.md"]);
  });
});

describe("drift over GitSource names the page whose cited lines changed", () => {
  let kb = "";

  beforeEach(() => {
    kb = mkdtempSync(join(tmpdir(), "accreta-git-kb-"));
  });

  afterEach(() => {
    rmSync(kb, { recursive: true, force: true });
  });

  /** Cite `path#locator` at HEAD, commit `change`, and rank the citing page as drift does. */
  async function rankAfter(path: string, change: () => void | Promise<void>, locator = "L5-L8") {
    const git = source();
    const from = await git.revision();
    mkdirSync(join(kb, "knowledge"), { recursive: true });
    writeFileSync(
      join(kb, "knowledge", "page.md"),
      `---\ntype: note\nsource: repo\nlast_verified_revision: ${from}\n---\n\nA claim.[^a]\n\n[^a]: repo @ ${from} · ${path}#${locator}\n`,
    );
    await change();
    await commit("second");

    const indexPath = join(kb, "index.sqlite");
    buildIndex({ root: kb, config: DEFAULT_CONFIG, indexPath });
    const db = openIndex(indexPath);
    try {
      const [entry] = (await detectDrift(db, git)).stale;
      return entry && pageChanges(entry)?.get("knowledge/page.md");
    } finally {
      db.close();
    }
  }

  beforeEach(async () => {
    write("docs/a.md", lines(12));
    write(".gitattributes", "docs/nodiff.md -diff\n");
    write("docs/nodiff.md", lines(12));
    write("docs/nul.md", lines(12, { 1: "a\0b" }));
    await commit("first");
  });

  test("a rename with an edit to the cited lines", async () => {
    const rank = await rankAfter("docs/a.md", async () => {
      await run(["mv", "docs/a.md", "docs/a2.md"]);
      write("docs/a2.md", lines(12, { 6: "changed" }));
    });
    expect(rank).toBe("changed");
  });

  // ADR-0015: a deleted file touches everything, and the old path is gone, so the citation must be re-pinned.
  test("a pure rename touches the citation, since its path no longer exists", async () => {
    const rank = await rankAfter("docs/a.md", () => run(["mv", "docs/a.md", "docs/a2.md"]));
    expect(rank).toBe("changed");
  });

  test("a -diff file with an edited cited line", async () => {
    const rank = await rankAfter("docs/nodiff.md", () =>
      write("docs/nodiff.md", lines(12, { 6: "changed" })),
    );
    expect(rank).toBe("changed");
  });

  test("a file with a NUL byte and an edited cited line", async () => {
    const rank = await rankAfter("docs/nul.md", () =>
      write("docs/nul.md", lines(12, { 1: "a\0b", 6: "changed" })),
    );
    expect(rank).toBe("changed");
  });

  test("an edit beside the cited lines of a -diff file leaves them untouched", async () => {
    const rank = await rankAfter("docs/nodiff.md", () =>
      write("docs/nodiff.md", lines(12, { 11: "changed" })),
    );
    expect(rank).toBe("untouched");
  });

  test("a file stored through a filter is not judged by its stored bytes", async () => {
    await run(["config", "filter.gz.clean", "gzip -cn"]);
    await run(["config", "filter.gz.smudge", "gzip -dc"]);
    await run(["config", "diff.gz.textconv", "gzip -dc"]);
    write(".gitattributes", "docs/gz.md filter=gz diff=gz\n");
    write("docs/gz.md", lines(400));
    await commit("add a filtered file");
    const rank = await rankAfter(
      "docs/gz.md",
      () => write("docs/gz.md", lines(400, { 301: "changed" })),
      "L300-L302",
    );
    expect(rank).toBe("changed");
  });
});

// Git versions a link's text, so an edit behind it lists only the target and never drifts the page.
describe("lint over GitSource asks a symlink citation to name its target", () => {
  let kb = "";

  beforeEach(async () => {
    kb = mkdtempSync(join(tmpdir(), "accreta-git-kb-"));
    write("docs/real.md", lines(12));
    symlinkSync("real.md", join(root, "docs", "link.md"));
    symlinkSync("docs", join(root, "alias"));
    writeFileSync(join(kb, "outside.md"), lines(12));
    symlinkSync(join(kb, "outside.md"), join(root, "docs", "away.md"));
    await commit("first");
  });

  afterEach(() => {
    rmSync(kb, { recursive: true, force: true });
  });

  async function lintCiting(path: string) {
    const git = source();
    const from = await git.revision();
    mkdirSync(join(kb, "knowledge"), { recursive: true });
    writeFileSync(
      join(kb, "knowledge", "page.md"),
      `---\ntype: note\nsource: repo\nlast_verified_revision: ${from}\n---\n\nA claim.[^a]\n\n[^a]: repo @ ${from} · ${path}#L5-L8\n`,
    );
    const indexPath = join(kb, "index.sqlite");
    buildIndex({ root: kb, config: DEFAULT_CONFIG, indexPath });
    const db = openIndex(indexPath);
    try {
      return (await lintCitations(db, new Map([["repo", git]]))).findings;
    } finally {
      db.close();
    }
  }

  test("a symlinked file", async () => {
    const [finding] = await lintCiting("docs/link.md");
    expect(finding).toMatchObject({ kind: "citation-path-missing", path: "knowledge/page.md" });
    expect(finding?.detail).toContain('"docs/real.md"');
  });

  test("a symlinked directory on the way", async () => {
    const [finding] = await lintCiting("alias/real.md");
    expect(finding).toMatchObject({ kind: "citation-path-missing", path: "knowledge/page.md" });
    expect(finding?.detail).toContain('"docs/real.md"');
  });

  test("a symlink out of the source names no target", async () => {
    const [finding] = await lintCiting("docs/away.md");
    expect(finding).toMatchObject({ kind: "citation-path-missing", path: "knowledge/page.md" });
    expect(finding?.detail).toContain("symlink to nothing");
    expect(finding?.detail).not.toContain("outside.md");
  });

  test("a symlink to a directory is not told to cite the directory", async () => {
    const [finding] = await lintCiting("alias");
    expect(finding).toMatchObject({ kind: "citation-path-missing", path: "knowledge/page.md" });
    expect(finding?.detail).toContain("symlink to a directory");
    expect(finding?.detail).not.toContain('cite "docs"');
  });

  test("a name in another Unicode normalisation says so", async () => {
    const [nfc, nfd] = ["docs/café.md".normalize("NFC"), "docs/café.md".normalize("NFD")];
    write(nfc, lines(12));
    await commit("add an accented name");
    // Only a normalisation-insensitive disk (APFS) resolves the other form at all.
    if (!existsSync(join(root, nfd))) return;
    const [finding] = await lintCiting(nfd);
    expect(finding?.detail).toContain("Unicode normalisation");
  });

  test("the target itself is found", async () => {
    expect(await lintCiting("docs/real.md")).toEqual([]);
  });
});

describe("GitSource rooted in a subdirectory of the repository", () => {
  let kb = "";

  const sub = (paths?: string[]) =>
    new GitSource({
      id: "repo",
      root: join(root, "sub"),
      citationFormat: "{source} @ {rev} · {path}#{locator}",
      paths,
    });

  async function head(): Promise<string> {
    const proc = Bun.spawn(["git", "rev-parse", "HEAD"], { cwd: root, stdout: "pipe" });
    return (await new Response(proc.stdout).text()).trim();
  }

  /** Index a page citing `docs/a.md#L5-L8` as verified at `from`, and run drift over the source. */
  async function drift(from: string) {
    mkdirSync(join(kb, "knowledge"), { recursive: true });
    writeFileSync(
      join(kb, "knowledge", "page.md"),
      `---\ntype: note\nsource: repo\nlast_verified_revision: ${from}\n---\n\nA claim.[^a]\n\n[^a]: repo @ ${from} · docs/a.md#L5-L8\n`,
    );
    const indexPath = join(kb, "index.sqlite");
    buildIndex({ root: kb, config: DEFAULT_CONFIG, indexPath });
    const db = openIndex(indexPath);
    try {
      const report = await detectDrift(db, sub());
      const [entry] = report.stale;
      return { report, rank: entry && pageChanges(entry)?.get("knowledge/page.md") };
    } finally {
      db.close();
    }
  }

  beforeEach(async () => {
    kb = mkdtempSync(join(tmpdir(), "accreta-git-kb-"));
    write("sub/docs/a.md", lines(12));
    write("other.md", lines(3));
    await commit("first");
  });

  afterEach(() => {
    rmSync(kb, { recursive: true, force: true });
  });

  test("an edit to a cited line is named", async () => {
    const from = await sub().revision();
    write("sub/docs/a.md", lines(12, { 6: "changed" }));
    await commit("edit a cited line");
    expect((await drift(from)).rank).toBe("changed");
  });

  test("a commit outside the root does not mark the page stale", async () => {
    const from = await sub().revision();
    write("other.md", lines(3, { 1: "changed" }));
    await commit("touch only other.md");
    const { report } = await drift(from);
    expect(report.stale).toEqual([]);
    expect(report.unresolvable).toEqual([]);
  });

  test("a commit outside the root does not move the revision", async () => {
    const before = await sub().revision();
    write("other.md", lines(3, { 1: "changed" }));
    await commit("touch only other.md");
    expect(await sub().revision()).toBe(before);
  });

  // A page may have recorded HEAD when it was a commit that never touched the root.
  test("a page verified at a commit outside the root is not stale after another", async () => {
    write("other.md", lines(3, { 1: "changed" }));
    await commit("touch only other.md");
    const from = await head();
    write("other.md", lines(3, { 2: "changed" }));
    await commit("touch only other.md again");
    const { report } = await drift(from);
    expect(report.stale).toEqual([]);
    expect(report.unresolvable).toEqual([]);
  });

  test("a page verified at a commit outside the root still sees its cited line change", async () => {
    write("other.md", lines(3, { 1: "changed" }));
    await commit("touch only other.md");
    const from = await head();
    write("sub/docs/a.md", lines(12, { 6: "changed" }));
    await commit("edit a cited line");
    expect((await drift(from)).rank).toBe("changed");
  });

  test("a scope path that climbs back into the root still scopes locate", async () => {
    expect(await sub(["../sub/docs"]).locate("docs/a.md")).toEqual({ verdict: "found" });
    expect(await sub(["../sub/other"]).locate("docs/a.md")).toMatchObject({ verdict: "missing" });
  });

  test("paths are relative to the root, and so is what changedSince names", async () => {
    const scoped = sub(["docs"]);
    const from = await scoped.revision();
    write("sub/docs/a.md", lines(12, { 6: "changed" }));
    write("other.md", lines(3, { 1: "changed" }));
    await commit("touch both");
    expect(await scoped.changedSince(from)).toEqual(["docs/a.md"]);
  });

  test("a pattern in paths is matched from the root, as revision() matches it", async () => {
    expect(await sub(["docs/*.md"]).locate("docs/a.md", "L12")).toEqual({ verdict: "found" });
    expect(await sub(["*.txt"]).locate("docs/a.md")).toMatchObject({ verdict: "missing" });
  });

  test("at the top level the revision is still HEAD, even when HEAD changed nothing", async () => {
    await run(["commit", "-q", "--allow-empty", "-m", "empty"]);
    expect(await source().revision()).toBe(await head());
  });
});

describe("GitSource spawn hardening", () => {
  const saved = { ...process.env };
  let outside = "";

  beforeEach(async () => {
    outside = mkdtempSync(join(tmpdir(), "accreta-git-outside-"));
    write("a.md", lines(3));
    await commit("first");
  });

  afterEach(() => {
    for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name];
    Object.assign(process.env, saved);
    rmSync(outside, { recursive: true, force: true });
  });

  /** An executable that leaves `marker` behind when run. */
  function plant(name: string, body = ""): { script: string; marker: string } {
    const script = join(outside, name);
    const marker = join(outside, `${name}.ran`);
    // The PATH under test may hold nothing but this script.
    const header = `#!/bin/sh\nPATH=/usr/bin:/bin\ntouch "${marker}"\n`;
    writeFileSync(script, header + body, { mode: 0o755 });
    return { script, marker };
  }

  /** Every kind of call the adapter makes, with a diff that is not empty, after `configure`. */
  async function everyCall(configure: () => Promise<void> | void): Promise<void> {
    const git = source();
    const from = await git.revision();
    write("a.md", lines(3, { 2: "changed" }));
    await commit("second");
    // The test's own `git commit` honours the config; only the adapter's calls are under test.
    await configure();
    await git.changedSince(from);
    await git.touchedSince(from, "a.md", ["L1-L2"]);
    await git.locate("a.md", "L1");
    await new GitSource({ id: "s", root, citationFormat: "x", paths: ["*.md"] }).locate("a.md");
  }

  test("core.fsmonitor from the environment never runs", async () => {
    const { script, marker } = plant("fsmonitor");
    await everyCall(() => {
      Object.assign(process.env, {
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "core.fsmonitor",
        GIT_CONFIG_VALUE_0: script,
      });
    });
    expect(existsSync(marker)).toBe(false);
  });

  test("core.fsmonitor from the repository's own config never runs", async () => {
    const { script, marker } = plant("fsmonitor");
    await everyCall(() => run(["config", "core.fsmonitor", script]));
    expect(existsSync(marker)).toBe(false);
  });

  test("GIT_DIR and friends from a hook do not point the adapter at another repository", async () => {
    const other = join(outside, "other");
    mkdirSync(other);
    for (const args of [
      ["init", "-q", "-b", "main"],
      ["-c", "user.email=t@e", "-c", "user.name=T", "commit", "-q", "--allow-empty", "-m", "x"],
    ])
      Bun.spawnSync(["git", ...args], { cwd: other });
    const own = await source().revision();
    Object.assign(process.env, {
      GIT_DIR: join(other, ".git"),
      GIT_WORK_TREE: other,
      GIT_INDEX_FILE: join(other, ".git", "index"),
      GIT_OBJECT_DIRECTORY: join(other, ".git", "objects"),
    });

    expect(await source().revision()).toBe(own);
    expect(await source().locate("a.md", "L1")).toEqual({ verdict: "found" });
  });

  test("a git call that hangs is killed with its helpers, and the error names it", async () => {
    const pidFile = join(outside, "helper.pid");
    plant("git", `sleep 30 &\necho $! > "${pidFile}"\nwait\n`);
    Object.assign(process.env, { PATH: outside, ACCRETA_GIT_TIMEOUT_MS: "1500" });

    const started = performance.now();
    const failure = await source()
      .revision()
      .catch((error: unknown) => error);
    expect(performance.now() - started).toBeLessThan(4_000);
    expect(failure).toBeInstanceOf(TimeoutError);
    expect((failure as Error).message).toBe(
      "git rev-parse --show-prefix did not finish within 1500 ms",
    );

    const helper = Number(readFileSync(pidFile, "utf-8"));
    const alive = () => {
      try {
        process.kill(helper, 0);
        return true;
      } catch {
        return false;
      }
    };
    for (let i = 0; i < 50 && alive(); i++) await Bun.sleep(20);
    expect(alive()).toBe(false);
  });

  test("a timeout that is not a whole number of milliseconds is refused", async () => {
    process.env.ACCRETA_GIT_TIMEOUT_MS = "soon";
    await expect(source().revision()).rejects.toThrow(
      "ACCRETA_GIT_TIMEOUT_MS must be a whole number",
    );
  });

  test("a revision shaped like an option is never read as one by diff", async () => {
    // A second layer behind knowsRevision, which already refuses this revision.
    class Trusting extends GitSource {
      override knowsRevision(): Promise<boolean> {
        return Promise.resolve(true);
      }
    }
    const git = new Trusting({ id: "repo", root, citationFormat: "x" });
    const written = join(outside, "written");

    await expect(git.changedSince(`--output=${written}`)).rejects.toThrow(GitCommandError);
    await expect(git.touchedSince(`--output=${written}`, "a.md", ["L1"])).rejects.toThrow(
      GitCommandError,
    );
    await Bun.sleep(100);
    expect(existsSync(written)).toBe(false);
  });

  test("a git in the source root never runs, even with the cwd on PATH", async () => {
    const marker = join(outside, "planted.ran");
    write("git", `#!/bin/sh\ntouch "${marker}"\necho ${"f".repeat(40)}\n`);
    chmodSync(join(root, "git"), 0o755);
    process.env.PATH = `.:${process.env.PATH}`;

    expect(await source().revision()).not.toBe("f".repeat(40));
    expect(existsSync(marker)).toBe(false);
  });
});
