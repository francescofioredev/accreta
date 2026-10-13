import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cite,
  compileCitationTemplate,
  detectDrift,
  openIndex,
  parseCitation,
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
  db.prepare(
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
  /** The same source as a new process would build it: nothing shared in memory. */
  reopen: () => SourceAdapter;
}

/** A source accreta can put a question to. */
interface QuestionableFixture extends Fixture {
  /** Write files into the source, committed where the source needs that to vouch for them. */
  add: (files: Record<string, string>) => Promise<void>;
  /** A symlink at `name` to `target`, as the source would hold one. */
  link: (name: string, target: string) => Promise<void>;
  /** The source declared narrower than its root, with a file on disk on each side of the line. */
  narrowed: () => Promise<{ adapter: SourceAdapter; inside: string; outside: string }>;
}

async function fsFixture(): Promise<QuestionableFixture> {
  const dir = join(root, "fs-source");
  mkdirSync(dir, { recursive: true });
  write(dir, "chapter-07.md", "one", 1000);
  const open = (extensions?: string[]) =>
    new FsSource({
      id: "src",
      root: dir,
      citationFormat: CITATION,
      stateDir: join(root, ".accreta"),
      extensions,
    });
  const adapter = open();
  let clock = 3000;
  const add = async (files: Record<string, string>) => {
    for (const [name, contents] of Object.entries(files)) write(dir, name, contents, clock++);
  };
  return {
    adapter,
    advance: async () => write(dir, "chapter-07.md", "two", 2000),
    verifiedRevision: () => adapter.revision(),
    reopen: open,
    add,
    link: async (name, target) => symlinkSync(target, join(dir, name)),
    narrowed: async () => {
      await add({ "notes.txt": "outside\n" });
      return { adapter: open([".md"]), inside: "chapter-07.md", outside: "notes.txt" };
    },
  };
}

async function gitFixture(): Promise<QuestionableFixture> {
  const dir = join(root, "git-source");
  mkdirSync(dir, { recursive: true });
  await git(dir, ["init", "-q", "-b", "main"]);
  await git(dir, ["config", "user.email", "test@example.com"]);
  await git(dir, ["config", "user.name", "Test"]);
  await git(dir, ["config", "commit.gpgsign", "false"]);
  write(dir, "chapter-07.md", "one");
  await git(dir, ["add", "-A"]);
  await git(dir, ["commit", "-q", "-m", "first"]);

  const open = (paths?: string[]) =>
    new GitSource({ id: "src", root: dir, citationFormat: CITATION, paths });
  const adapter = open();
  const add = async (files: Record<string, string>) => {
    for (const [name, contents] of Object.entries(files)) write(dir, name, contents);
    await git(dir, ["add", "-A"]);
    await git(dir, ["commit", "-q", "-m", "add"]);
  };
  return {
    adapter,
    advance: async () => {
      write(dir, "chapter-07.md", "two");
      await git(dir, ["add", "-A"]);
      await git(dir, ["commit", "-q", "-m", "second"]);
    },
    verifiedRevision: () => adapter.revision(),
    reopen: open,
    add,
    link: async (name, target) => {
      symlinkSync(target, join(dir, name));
      await git(dir, ["add", "-A"]);
      await git(dir, ["commit", "-q", "-m", "link"]);
    },
    narrowed: async () => {
      await add({ "docs/a.md": "inside\n", "other/b.md": "outside\n" });
      return { adapter: open(["docs"]), inside: "docs/a.md", outside: "other/b.md" };
    },
  };
}

async function delegatedFixture(): Promise<Fixture> {
  const open = () =>
    new DelegatedSource({
      id: "src",
      via: "notion",
      scope: "The Design decisions page and everything below it.",
      citationFormat: CITATION,
    });
  // Nothing to advance: a source accreta cannot read is also one it cannot move.
  return {
    adapter: open(),
    advance: async () => {},
    verifiedRevision: async () => "2026-08-01T10:22:00Z",
    reopen: open,
  };
}

/** Every adapter, on the half of the contract that does not need a reachable source. */
const EVERY_ADAPTER: [string, () => Promise<Fixture>][] = [
  ["fs", fsFixture],
  ["git", gitFixture],
  ["delegated", delegatedFixture],
];

/** The adapters accreta can put a question to. */
const QUESTIONABLE: [string, () => Promise<QuestionableFixture>][] = [
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

    test("cite leaves the revision an ingest pinned alone", async () => {
      const { adapter, advance, verifiedRevision } = await makeFixture();
      const verifiedAt = await verifiedRevision();
      adapter.pinRevision(verifiedAt);
      await advance();

      await cite(new Map([["src", adapter]]), CITATION, { sourceId: "src", path: "chapter-07.md" });
      expect(adapter.citation("chapter-07.md")).toContain(verifiedAt);
    });

    test("cite's footnote reads back as what it cites", async () => {
      const { adapter } = await makeFixture();
      const target = { sourceId: "src", path: "chapter-07.md", locator: "L1" };
      const cited = await cite(new Map([["src", adapter]]), CITATION, target);

      const template = compileCitationTemplate(CITATION);
      if (!template.ok) throw new Error(template.reason);
      expect(template.template.read(cited.footnote)).toEqual({
        ...target,
        revision: cited.revision ?? UNPINNED_REVISION,
      });
      expect(parseCitation(cited.canonicalSource)).toEqual(target);
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

    test("a page goes stale for an adapter that did not see the revision taken", async () => {
      const { adapter, advance, reopen } = await makeFixture();
      const verifiedAt = await adapter.revision();
      addPage("knowledge/a.md", "src", verifiedAt);

      await advance();

      // Every CLI run is a new process, so the revision was taken by a different instance.
      const report = await detectDrift(db, reopen());
      expect(report.unresolvable).toEqual([]);
      expect(report.stale.flatMap((entry) => entry.pages)).toEqual(["knowledge/a.md"]);
      expect(report.stale[0]?.changedPaths).toEqual(["chapter-07.md"]);
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

    // A citation outside what `revision()` covers could never drift, so it must not be vouched for.
    test("locate refuses a path on disk that the source does not declare", async () => {
      const { narrowed, add } = await makeFixture();
      const { adapter, inside, outside } = await narrowed();

      expect(await adapter.locate(inside, "L1")).toEqual({ verdict: "found" });
      for (const locator of [undefined, "L1"]) {
        expect(await adapter.locate(outside, locator)).toMatchObject({
          verdict: "missing",
          part: "path",
        });
      }

      // The declaration must really bound the revision, or the case above proves nothing.
      const before = await adapter.revision();
      await add({ [outside]: "edited\n" });
      expect(await adapter.revision()).toBe(before);
      await add({ [inside]: "edited\n" });
      expect(await adapter.revision()).not.toBe(before);
    });

    test("locate refuses a symlink, whose target the revision does not hold", async () => {
      const { adapter, link } = await makeFixture();
      writeFileSync(join(root, "outside.md"), "one\ntwo\nthree\n", "utf-8");
      await link("alias.md", "chapter-07.md");
      await link("up", "..");

      for (const path of ["alias.md", "up/outside.md"]) {
        expect(await adapter.locate(path, "L1")).toMatchObject({
          verdict: "missing",
          part: "path",
        });
      }
      expect(await adapter.locate("chapter-07.md", "L1")).toEqual({ verdict: "found" });
    });

    // Drift compares the path as written, so a citation spelled any other way would never drift.
    test("locate refuses a path not written the way the source names it", async () => {
      const { adapter } = await makeFixture();
      for (const path of [
        "./chapter-07.md",
        "chapter-07.md/",
        ".//chapter-07.md",
        "x/../chapter-07.md",
        "CHAPTER-07.md",
        "chapter-07.md\0x",
      ]) {
        expect(await adapter.locate(path)).toMatchObject({ verdict: "missing", part: "path" });
      }
    });

    test("a final newline ends the last line rather than opening another", async () => {
      const { adapter, add } = await makeFixture();
      await add({
        "two.md": "one\ntwo\n",
        "three.md": "one\ntwo\nthree\n",
        "bare.md": "one\ntwo\nthree",
        "empty.md": "",
        "blank.md": "\n",
      });

      expect(await adapter.locate("two.md", "L2")).toEqual({ verdict: "found" });
      expect(await adapter.locate("two.md", "L3")).toMatchObject({
        verdict: "missing",
        part: "locator",
      });
      expect(await adapter.locate("three.md", "L3")).toEqual({ verdict: "found" });
      expect(await adapter.locate("bare.md", "L3")).toEqual({ verdict: "found" });
      expect(await adapter.locate("bare.md", "L4")).toMatchObject({ part: "locator" });
      expect(await adapter.locate("empty.md")).toEqual({ verdict: "found" });
      expect(await adapter.locate("empty.md", "L1")).toMatchObject({ part: "locator" });
      expect(await adapter.locate("blank.md", "L1")).toEqual({ verdict: "found" });
      expect(await adapter.locate("blank.md", "L2")).toMatchObject({ part: "locator" });
    });

    test("cite names the revision the source is at now, not the one it started at", async () => {
      const { adapter, advance } = await makeFixture();
      const before = await adapter.revision();
      await advance();

      const sources = new Map([["src", adapter]]);
      const cited = await cite(sources, CITATION, {
        sourceId: "src",
        path: "chapter-07.md",
        locator: "L1",
      });
      expect(cited.revision).toBe(await adapter.revision());
      expect(cited.revision).not.toBe(before);
      expect(cited.footnote).toBe(`src @ ${cited.revision} · chapter-07.md#L1`);
      expect(cited.location).toEqual({ verdict: "found" });
      expect(cited.revisionFrom).toBe("source");
      expect(cited.delegated).toBeUndefined();
    });

    test("cite refuses a revision the agent observed, since the source answers its own", async () => {
      const { adapter } = await makeFixture();
      const sources = new Map([["src", adapter]]);
      await expect(
        cite(
          sources,
          CITATION,
          { sourceId: "src", path: "chapter-07.md" },
          { observedRevision: "deadbeef" },
        ),
      ).rejects.toThrow('Source "src" reports its own revision');
    });

    test("cite passes on the source's verdict for a place that is not there", async () => {
      const { adapter } = await makeFixture();
      const sources = new Map([["src", adapter]]);
      const past = await cite(sources, CITATION, {
        sourceId: "src",
        path: "chapter-07.md",
        locator: "L99999",
      });
      const absent = await cite(sources, CITATION, { sourceId: "src", path: "never-written.md" });

      expect(past.location).toMatchObject({ verdict: "missing", part: "locator" });
      expect(absent.location).toMatchObject({ verdict: "missing", part: "path" });
    });
  });
}
