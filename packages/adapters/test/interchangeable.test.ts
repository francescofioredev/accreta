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
import { DelegatedSource } from "@accreta/adapter-delegated";

/**
 * The property this epic exists to establish: drift detection is written
 * against `SourceAdapter` alone, so a filesystem directory and a git repository
 * drive it identically. Nothing in `packages/core` branches on which one it has.
 *
 * These cases are deliberately run over the same assertions rather than written
 * once per adapter — if two adapters ever needed different expectations, the
 * abstraction would be leaking.
 *
 * There are two tables, and the split is the honest part. `EVERY_ADAPTER`
 * carries what any source must do, whoever reads it: render a citation, name
 * the revision it was pinned to, and admit when it was pinned to nothing. That
 * is the provenance contract, and it does not depend on accreta being able to
 * reach anything. `QUESTIONABLE` carries drift and location checks, which
 * presuppose a source accreta can interrogate — a delegated source cannot be
 * asked, and asserting it answers would be asserting a fiction.
 *
 * Two contracts rather than one is a real cost, recorded in ADR-0012. What must
 * not happen is a third table, or a per-adapter exception inside either of
 * these.
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

const CITATION = "{source} @ {rev} · {path}#{locator}";

/** A source at an initial revision, plus a way to move it forward. */
interface Fixture {
  adapter: SourceAdapter;
  advance: () => Promise<void>;
  /**
   * A revision a claim could have been verified against.
   *
   * Not `adapter.revision()`: for a source accreta cannot reach, the revision a
   * page records came from the agent, not from asking. The provenance cases
   * below are about what a citation renders once someone has said what to cite
   * against, and who said it is a different question.
   */
  verifiedRevision: () => Promise<string>;
}

async function fsFixture(): Promise<Fixture> {
  const dir = join(root, "fs-source");
  mkdirSync(dir, { recursive: true });
  write(dir, "chapter-07.md", "one", 1000);
  const adapter = new FsSource({ id: "src", root: dir, citationFormat: CITATION });
  return {
    adapter,
    advance: async () => write(dir, "chapter-07.md", "two", 2000),
    verifiedRevision: () => adapter.revision(),
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
    verifiedRevision: () => adapter.revision(),
  };
}

async function delegatedFixture(): Promise<Fixture> {
  const adapter = new DelegatedSource({
    id: "src",
    via: "notion",
    scope: "The Design decisions page and everything below it.",
    citationFormat: CITATION,
  });
  // Nothing to advance: a source accreta cannot read is also one it cannot move.
  return {
    adapter,
    advance: async () => {},
    verifiedRevision: async () => "2026-08-01T10:22:00Z",
  };
}

/** Every adapter, on the half of the contract that does not need a reachable source. */
const EVERY_ADAPTER: [string, () => Promise<Fixture>][] = [
  ["fs", fsFixture],
  ["git", gitFixture],
  ["delegated", delegatedFixture],
];

/** The adapters accreta can put a question to. */
const QUESTIONABLE: [string, () => Promise<Fixture>][] = [
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

for (const [name, makeFixture] of EVERY_ADAPTER) {
  describe(`the provenance contract, over the ${name} adapter`, () => {
    test("a citation renders through the configured format", async () => {
      const { adapter } = await makeFixture();
      expect(adapter.citation("chapter-07.md", "L142-L158")).toContain("chapter-07.md#L142-L158");
    });

    // The case above asserts only the path and locator tail, which is how `fs`
    // shipped a citation whose revision was the literal string "unknown" and
    // passed its own conformance suite. Provenance is the project's first
    // stated property; these two cases are what make it checkable.
    test("a citation names the revision it was pinned to", async () => {
      const { adapter, advance, verifiedRevision } = await makeFixture();
      const verifiedAt = await verifiedRevision();

      adapter.pinRevision(verifiedAt);
      await advance();

      // Pinned before the source moved, so the citation must still name the
      // revision the claim was checked against rather than where the source
      // has since got to.
      expect(adapter.citation("chapter-07.md", "L142-L158")).toContain(verifiedAt);
      expect(adapter.citation("chapter-07.md", "L142-L158")).not.toContain(UNPINNED_REVISION);
    });

    test("an unpinned citation says so rather than inventing a revision", async () => {
      const { adapter, verifiedRevision } = await makeFixture();
      const real = await verifiedRevision();

      // Never told what to cite against: the honest answer is the shared
      // sentinel. Naming a real revision here would be a guess dressed as
      // provenance, and every adapter must guess identically or the reader
      // cannot tell which it is holding.
      expect(adapter.citation("chapter-07.md")).toContain(UNPINNED_REVISION);
      expect(adapter.citation("chapter-07.md")).not.toContain(real);
    });
  });
}

for (const [name, makeFixture] of QUESTIONABLE) {
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

    test("locate finds a path inside the root, and misses one that is not there", async () => {
      const { adapter } = await makeFixture();
      expect(await adapter.locate("chapter-07.md")).toEqual({ verdict: "found" });
      expect(await adapter.locate("never-written.md")).toMatchObject({
        verdict: "missing",
        part: "path",
      });
    });

    test("locate bounds a line range against the document", async () => {
      const { adapter } = await makeFixture();
      expect(await adapter.locate("chapter-07.md", "L1")).toEqual({ verdict: "found" });
      expect(await adapter.locate("chapter-07.md", "L99999")).toMatchObject({
        verdict: "missing",
        part: "locator",
      });
    });

    test("locate refuses a path that climbs out of the declared scope", async () => {
      const { adapter } = await makeFixture();
      // The argument is not always operator-written: a `canonical_source` is
      // authored by a model and handed here by the citation checks, so an
      // escaping path would turn "verify this citation" into "read this file".
      // The verdict that matters is the one this must never be: `found`.
      writeFileSync(join(root, "outside.md"), "SECRET", "utf-8");

      for (const escape of ["../outside.md", "./../outside.md", join(root, "outside.md")]) {
        expect(await adapter.locate(escape)).toMatchObject({ verdict: "missing", part: "path" });
      }
    });
  });
}
