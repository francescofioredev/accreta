import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  detectDrift,
  openIndex,
  UNPINNED_REVISION,
  type Database,
  type SourceAdapter,
} from "@accreta/core";
import { FsSource } from "@accreta/adapter-fs";
import { GitSource } from "@accreta/adapter-git";

/**
 * The property this epic exists to establish: drift detection is written
 * against `SourceAdapter` alone, so a filesystem directory and a git repository
 * drive it identically. Nothing in `packages/core` branches on which one it has.
 *
 * These cases are deliberately run twice over the same assertions rather than
 * written once per adapter — if the two ever needed different expectations, the
 * abstraction would be leaking.
 */

let root = "";
let db: Database;

function addPage(path: string, source: string, verifiedAt: string | null): void {
  db.query(
    `INSERT INTO pages (path, type, title, source, last_verified_revision, frontmatter_json, body, mtime)
     VALUES (?, 'note', ?, ?, ?, '{}', '', 0)`,
  ).run(path, path, source, verifiedAt);
}

async function git(cwd: string, args: string[]): Promise<void> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if ((await proc.exited) !== 0) {
    throw new Error(`git ${args.join(" ")}: ${await new Response(proc.stderr).text()}`);
  }
}

function write(dir: string, name: string, contents: string, mtime?: number): void {
  const full = join(dir, name);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, contents, "utf-8");
  if (mtime !== undefined) utimesSync(full, mtime, mtime);
}

const CITATION = "{source} @ {rev} · {path}#L{start}-L{end}";

/** A source at an initial revision, plus a way to move it forward. */
interface Fixture {
  adapter: SourceAdapter;
  advance: () => Promise<void>;
}

async function fsFixture(): Promise<Fixture> {
  const dir = join(root, "fs-source");
  mkdirSync(dir, { recursive: true });
  write(dir, "chapter-07.md", "one", 1000);
  const adapter = new FsSource({ id: "src", root: dir, citationFormat: CITATION });
  return {
    adapter,
    advance: async () => write(dir, "chapter-07.md", "two", 2000),
  };
}

async function gitFixture(): Promise<Fixture> {
  const dir = join(root, "git-source");
  mkdirSync(dir, { recursive: true });
  await git(dir, ["init", "-q", "-b", "main"]);
  await git(dir, ["config", "user.email", "test@example.com"]);
  await git(dir, ["config", "user.name", "Test"]);
  await git(dir, ["config", "commit.gpgsign", "false"]);
  write(dir, "chapter-07.md", "one");
  await git(dir, ["add", "-A"]);
  await git(dir, ["commit", "-q", "-m", "first"]);

  const adapter = new GitSource({ id: "src", root: dir, citationFormat: CITATION });
  return {
    adapter,
    advance: async () => {
      write(dir, "chapter-07.md", "two");
      await git(dir, ["add", "-A"]);
      await git(dir, ["commit", "-q", "-m", "second"]);
    },
  };
}

const ADAPTERS: [string, () => Promise<Fixture>][] = [
  ["fs", fsFixture],
  ["git", gitFixture],
];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "accreta-interop-"));
  db = openIndex(join(root, "index.sqlite"));
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

for (const [name, makeFixture] of ADAPTERS) {
  describe(`drift detection over the ${name} adapter`, () => {
    test("a page verified at the current revision is not stale", async () => {
      const { adapter } = await makeFixture();
      addPage("knowledge/a.md", "src", await adapter.revision());

      const report = await detectDrift(db, adapter);
      expect(report.stale).toEqual([]);
      expect(report.unresolvable).toEqual([]);
    });

    test("a page is stale once the source changes under it", async () => {
      const { adapter, advance } = await makeFixture();
      const verifiedAt = await adapter.revision();
      addPage("knowledge/a.md", "src", verifiedAt);

      await advance();

      const report = await detectDrift(db, adapter);
      expect(report.stale.flatMap((entry) => entry.pages)).toEqual(["knowledge/a.md"]);
      expect(report.stale[0]?.changedPaths).toEqual(["chapter-07.md"]);
      expect(report.currentRevision).not.toBe(verifiedAt);
    });

    test("a page recording no revision is unverifiable", async () => {
      const { adapter } = await makeFixture();
      addPage("knowledge/a.md", "src", null);

      const report = await detectDrift(db, adapter);
      expect(report.unverifiable).toEqual(["knowledge/a.md"]);
    });

    test("a revision the source cannot place is reported rather than assumed current", async () => {
      const { adapter } = await makeFixture();
      addPage("knowledge/a.md", "src", "f".repeat(40));

      const report = await detectDrift(db, adapter);
      expect(report.unresolvable.map((u) => u.pages).flat()).toEqual(["knowledge/a.md"]);
      expect(report.stale).toEqual([]);
    });

    test("a citation renders through the configured format", async () => {
      const { adapter } = await makeFixture();
      expect(adapter.citation("chapter-07.md", [142, 158])).toContain("chapter-07.md#L142-L158");
    });

    // The case above asserts only the path and line tail, which is how `fs`
    // shipped a citation whose revision was the literal string "unknown" and
    // passed its own conformance suite. Provenance is the project's first
    // stated property; these two cases are what make it checkable.
    test("a citation names the revision it was pinned to", async () => {
      const { adapter, advance } = await makeFixture();
      const verifiedAt = await adapter.revision();

      adapter.pinRevision(verifiedAt);
      await advance();

      // Pinned before the source moved, so the citation must still name the
      // revision the claim was checked against rather than where the source
      // has since got to.
      expect(adapter.citation("chapter-07.md", [142, 158])).toContain(verifiedAt);
      expect(adapter.citation("chapter-07.md", [142, 158])).not.toContain(UNPINNED_REVISION);
    });

    test("an unpinned citation says so rather than inventing a revision", async () => {
      const { adapter } = await makeFixture();
      const current = await adapter.revision();

      // Asked for its revision but never told what to cite against: the honest
      // answer is the shared sentinel. Naming `current` here would be a guess
      // dressed as provenance, and every adapter must guess identically or the
      // reader cannot tell which it is holding.
      expect(adapter.citation("chapter-07.md")).toContain(UNPINNED_REVISION);
      expect(adapter.citation("chapter-07.md")).not.toContain(current);
    });

    test("read serves a path inside the root", async () => {
      const { adapter } = await makeFixture();
      expect(await adapter.read("chapter-07.md")).toContain("one");
    });

    test("read refuses a path that climbs out of the root", async () => {
      const { adapter } = await makeFixture();
      // The argument is not always operator-written: a `canonical_source` is
      // authored by a model and handed here by the citation checks, so an
      // escaping path would turn "verify this citation" into "read this file".
      writeFileSync(join(root, "outside.md"), "SECRET", "utf-8");

      for (const escape of ["../outside.md", "./../outside.md", join(root, "outside.md")]) {
        await expect(adapter.read(escape)).rejects.toThrow(/outside the source root/);
      }
    });
  });
}
