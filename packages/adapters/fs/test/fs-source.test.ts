import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  truncateSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { detectDrift, openIndex, UnknownRevisionError, type Database } from "@accreta/core";
import { FsSource, SNAPSHOT_MAX_BYTES, snapshotDirFor, snapshotHealth } from "../src/index.ts";

let root = "";

function write(relativePath: string, contents: string, mtimeSeconds?: number): void {
  const full = join(root, relativePath);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, contents, "utf-8");
  if (mtimeSeconds !== undefined) utimesSync(full, mtimeSeconds, mtimeSeconds);
}

function source() {
  return new FsSource({
    id: "docs",
    root,
    citationFormat: "{source} @ {rev} · {path}#{locator}",
  });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "accreta-fs-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("FsSource", () => {
  test("a revision is stable while nothing changes", async () => {
    write("a.md", "one", 1000);
    const fs = source();
    expect(await fs.revision()).toBe(await fs.revision());
  });

  test("a revision changes when a file is modified", async () => {
    write("a.md", "one", 1000);
    const fs = source();
    const before = await fs.revision();

    write("a.md", "two", 2000);
    expect(await fs.revision()).not.toBe(before);
  });

  test("a revision changes when a file is added, and returns when it is removed", async () => {
    write("a.md", "one", 1000);
    const fs = source();
    const before = await fs.revision();

    write("b.md", "two", 1000);
    expect(await fs.revision()).not.toBe(before);

    rmSync(join(root, "b.md"));
    expect(await fs.revision()).toBe(before);
  });

  test("changedSince names the files that moved", async () => {
    write("a.md", "one", 1000);
    write("b.md", "two", 1000);
    const fs = source();
    const first = await fs.revision();

    write("b.md", "changed", 2000);
    expect(await fs.changedSince(first)).toEqual(["b.md"]);
  });

  test("changedSince reports additions and deletions", async () => {
    write("a.md", "one", 1000);
    const fs = source();
    const first = await fs.revision();

    write("b.md", "new", 1000);
    rmSync(join(root, "a.md"));
    expect(await fs.changedSince(first)).toEqual(["a.md", "b.md"]);
  });

  test("an unknown revision is reported rather than answered as 'nothing changed'", async () => {
    write("a.md", "one", 1000);
    const fs = source();
    expect(fs.changedSince("deadbeef")).rejects.toThrow(UnknownRevisionError);
  });

  test("locate finds a path inside the root", async () => {
    write("docs/a.md", "hello", 1000);
    expect(await source().locate("docs/a.md")).toEqual({ verdict: "found" });
  });

  test("locate bounds a line range against the file", async () => {
    write("docs/a.md", "one\ntwo\nthree", 1000);
    expect(await source().locate("docs/a.md", "L2-L3")).toEqual({ verdict: "found" });

    const past = await source().locate("docs/a.md", "L2-L9");
    expect(past.verdict).toBe("missing");
    expect(past).toMatchObject({ part: "locator" });
  });

  test("locate refuses a locator this source cannot address by", async () => {
    write("docs/a.md", "hello", 1000);
    // A file is addressed by line. A block id is not a range this source has
    // any way to check, and saying "found" would be an invention.
    expect(await source().locate("docs/a.md", "block-a1b2c3")).toMatchObject({
      verdict: "missing",
      part: "locator",
    });
  });

  test("hidden directories and node_modules are not part of the source", async () => {
    write("a.md", "one", 1000);
    const fs = source();
    const before = await fs.revision();

    write("node_modules/pkg/index.js", "junk", 1000);
    write(".git/config", "junk", 1000);
    expect(await fs.revision()).toBe(before);
  });

  test("an extension filter narrows what counts as part of the source", async () => {
    write("a.md", "one", 1000);
    write("b.txt", "two", 1000);
    const markdown = new FsSource({
      id: "docs",
      root,
      citationFormat: "{source} @ {rev} · {path}",
      extensions: [".md"],
    });
    const before = await markdown.revision();

    write("b.txt", "changed", 2000);
    expect(await markdown.revision()).toBe(before);
  });

  test("a citation renders the configured format", () => {
    expect(source().citation("chapter-07.md", "L142-L158")).toContain("chapter-07.md#L142-L158");
  });

  test("a citation without a locator drops the locator decoration", () => {
    const cite = source().citation("chapter-07.md");
    expect(cite).not.toContain("{locator}");
    expect(cite).not.toContain("undefined");
  });

  test("a citation names the pinned revision, not the tree's current hash", async () => {
    const fs = source();
    const verifiedAt = await fs.revision();
    fs.pinRevision(verifiedAt);

    write("chapter-07.md", "rewritten after the claim was checked", 3000);
    expect(await fs.revision()).not.toBe(verifiedAt);

    expect(fs.citation("chapter-07.md", "L142-L158")).toContain(verifiedAt);
  });
});

const setTime = (file: string, ms: number) => utimesSync(file, ms / 1000, ms / 1000);

function verify(db: Database, page: string, revision: string): void {
  db.query(
    `INSERT INTO pages (path, type, title, source, last_verified_revision, frontmatter_json, body, mtime)
     VALUES (?, 'note', ?, 'docs', ?, '{}', '', 0)
     ON CONFLICT(path) DO UPDATE SET last_verified_revision = excluded.last_verified_revision`,
  ).run(page, page, revision);
}

describe("FsSource snapshots on disk", () => {
  let state = "";
  const snapshots = () => snapshotDirFor(state, "docs");
  const snapshotFile = (revision: string) => join(snapshots(), `${revision}.json`);
  const persisted = () =>
    new FsSource({
      id: "docs",
      root,
      citationFormat: "{source} @ {rev} · {path}",
      stateDir: state,
    });

  beforeEach(() => {
    state = mkdtempSync(join(tmpdir(), "accreta-fs-state-"));
  });

  afterEach(() => {
    rmSync(state, { recursive: true, force: true });
  });

  test("a revision taken by one instance can be diffed by the next", async () => {
    write("a.md", "one", 1000);
    const verifiedAt = await persisted().revision();

    write("a.md", "two", 2000);
    expect(await persisted().changedSince(verifiedAt)).toEqual(["a.md"]);
  });

  test("a missing snapshot is an unknown revision", async () => {
    write("a.md", "one", 1000);
    const verifiedAt = await persisted().revision();
    rmSync(snapshotFile(verifiedAt));

    expect(persisted().changedSince(verifiedAt)).rejects.toThrow(UnknownRevisionError);
  });

  test("a truncated snapshot is an unknown revision", async () => {
    write("a.md", "one", 1000);
    const verifiedAt = await persisted().revision();
    const text = readFileSync(snapshotFile(verifiedAt), "utf-8");
    writeFileSync(snapshotFile(verifiedAt), text.slice(0, text.length - 5));

    expect(persisted().changedSince(verifiedAt)).rejects.toThrow(UnknownRevisionError);
  });

  test("a hand-edited snapshot is an unknown revision, not a wrong diff", async () => {
    write("a.md", "one", 1000);
    const verifiedAt = await persisted().revision();
    write("a.md", "two", 2000);

    // Edited to match the tree as it is now, so trusting it would report "nothing changed".
    const snapshot = JSON.parse(readFileSync(snapshotFile(verifiedAt), "utf-8"));
    snapshot.entries = [["a.md", statSync(join(root, "a.md")).mtimeMs]];
    writeFileSync(snapshotFile(verifiedAt), JSON.stringify(snapshot));

    expect(persisted().changedSince(verifiedAt)).rejects.toThrow(UnknownRevisionError);
  });

  test("a revision that is not a hash never names a file", async () => {
    write("a.md", "one", 1000);
    await persisted().revision();

    for (const revision of ["../snapshots/x", "../../etc/passwd", ""]) {
      expect(persisted().changedSince(revision)).rejects.toThrow(UnknownRevisionError);
    }
  });

  test("a snapshot that cannot be written leaves the revision unknown, not the check failed", async () => {
    write("a.md", "one", 1000);
    writeFileSync(join(state, "blocker"), "a file where a directory should be");
    const unwritable = () =>
      new FsSource({
        id: "docs",
        root,
        citationFormat: "{rev}",
        stateDir: join(state, "blocker"),
      });

    const verifiedAt = await unwritable().revision();
    expect(unwritable().changedSince(verifiedAt)).rejects.toThrow(UnknownRevisionError);
  });

  test("the snapshot directory keeps itself out of git", async () => {
    write("a.md", "one", 1000);
    await persisted().revision();
    expect(readFileSync(join(snapshots(), ".gitignore"), "utf-8")).toBe("*\n");
  });

  test("a snapshot over the cap is never written, and health says why", async () => {
    write("a.md", "one", 1000);
    const capped = () =>
      new FsSource({
        id: "docs",
        root,
        citationFormat: "{rev}",
        stateDir: state,
        snapshotMaxBytes: 10,
      });
    const verifiedAt = await capped().revision();

    expect(existsSync(snapshotFile(verifiedAt))).toBe(false);
    expect(capped().changedSince(verifiedAt)).rejects.toThrow(UnknownRevisionError);
    const health = snapshotHealth({
      id: "docs",
      root,
      citationFormat: "",
      stateDir: state,
      snapshotMaxBytes: 10,
    });
    expect(health.persists).toBe(false);
    expect(health.detail).toContain("over the");
  });

  test.skipIf(process.getuid === undefined)(
    "only this user can read or write the snapshots",
    async () => {
      write("a.md", "one", 1000);
      const verifiedAt = await persisted().revision();

      for (const dir of [dirname(snapshots()), snapshots()]) {
        expect(statSync(dir).mode & 0o777).toBe(0o700);
      }
      for (const file of [snapshotFile(verifiedAt), join(snapshots(), ".last-run")]) {
        expect(statSync(file).mode & 0o777).toBe(0o600);
      }
    },
  );

  test.skipIf(process.getuid === undefined)(
    "a group-writable snapshot directory turns persistence off, and health says why",
    async () => {
      write("a.md", "one", 1000);
      await persisted().revision();
      chmodSync(snapshots(), 0o770);

      write("a.md", "two", 2000);
      const verifiedAt = await persisted().revision();
      expect(existsSync(snapshotFile(verifiedAt))).toBe(false);
      expect(persisted().changedSince(verifiedAt)).rejects.toThrow(UnknownRevisionError);
      const health = snapshotHealth({ id: "docs", root, citationFormat: "", stateDir: state });
      expect(health).toEqual({
        persists: false,
        detail: `${snapshots()} is group- or world-writable`,
      });
    },
  );

  for (const [what, mode] of [
    ["a world-writable, sticky state dir, as /tmp is", 0o1777],
    ["a group-writable state dir, as umask 002 makes it", 0o775],
  ] as const) {
    test.skipIf(process.getuid === undefined)(`${what} still persists`, async () => {
      // chmodSync drops the sticky bit under Bun on macOS; chmod(1) does not.
      expect(Bun.spawnSync(["chmod", mode.toString(8), state]).exitCode).toBe(0);
      expect(statSync(state).mode & 0o7777).toBe(mode);
      write("a.md", "one", 1000);
      const verifiedAt = await persisted().revision();
      write("a.md", "two", 2000);

      expect(await persisted().changedSince(verifiedAt)).toEqual(["a.md"]);
      expect(statSync(snapshots()).mode & 0o777).toBe(0o700);
      expect(snapshotHealth({ id: "docs", root, citationFormat: "", stateDir: state })).toEqual({
        persists: true,
      });
    });
  }

  test.skipIf(process.getuid === undefined)(
    "a state dir anyone can write, without the sticky bit, turns persistence off",
    async () => {
      chmodSync(state, 0o777);
      write("a.md", "one", 1000);
      const verifiedAt = await persisted().revision();

      expect(existsSync(snapshots())).toBe(false);
      expect(persisted().changedSince(verifiedAt)).rejects.toThrow(UnknownRevisionError);
      expect(snapshotHealth({ id: "docs", root, citationFormat: "", stateDir: state })).toEqual({
        persists: false,
        detail: `${state} is world-writable without the sticky bit`,
      });
    },
  );

  test("health reports a kept set over budget without refusing it", async () => {
    write("a.md", "one", 1000);
    await persisted().revision();
    write("a.md", "two", 2000);
    await persisted().revision();

    const health = snapshotHealth({
      id: "docs",
      root,
      citationFormat: "",
      stateDir: state,
      snapshotBudgetBytes: 1,
    });
    expect(health.persists).toBe(true);
    expect(health.detail).toContain("over the");
  });

  describe("pruning", () => {
    const DAY = 86_400_000;
    const marker = () => join(snapshots(), ".last-run");
    const budgeted = (snapshotBudgetBytes: number) =>
      new FsSource({
        id: "docs",
        root,
        citationFormat: "{rev}",
        stateDir: state,
        snapshotBudgetBytes,
      });
    /** As if the last run happened `days` ago: its marker, then the files it wrote or read. */
    const pause = (days: number) => {
      const then = Date.now() - days * DAY;
      for (const name of readdirSync(snapshots())) setTime(join(snapshots(), name), then);
      if (existsSync(marker())) setTime(marker(), then - 60_000);
    };
    let db: Database;

    beforeEach(() => {
      db = openIndex(join(state, "index.sqlite"));
    });

    afterEach(() => {
      db.close();
    });

    test("a corpus left alone for 91 days still places all 10 cited revisions", async () => {
      for (let run = 0; run < 10; run++) {
        write("a.md", String(run), 1000 + run);
        verify(db, `p${run}.md`, (await detectDrift(db, persisted())).currentRevision!);
      }
      pause(91);

      write("a.md", "after the pause", 5000);
      const report = await detectDrift(db, persisted());
      expect(report.unresolvable).toEqual([]);
      expect(report.stale.flatMap((entry) => entry.pages)).toHaveLength(10);
    });

    test("a long-lived instance keeps the revision it answers from memory", async () => {
      const server = budgeted(1);
      write("a.md", "one", 1000);
      const cited = await server.revision();
      pause(91);

      write("a.md", "two", 2000);
      await server.revision();
      expect(await server.changedSince(cited)).toEqual(["a.md"]);
      write("a.md", "three", 3000);
      await server.revision();

      expect(await budgeted(1).changedSince(cited)).toEqual(["a.md"]);
    });

    test("70 change, drift, verify cycles under a binding budget strand no cited revision", async () => {
      for (let run = 0; run < 70; run++) {
        write("a.md", String(run), 1000 + run);
        const report = await detectDrift(db, budgeted(2048));
        expect(report.unresolvable).toEqual([]);
        verify(db, `p${run}.md`, report.currentRevision!);
      }
      write("a.md", "last", 5000);
      const report = await detectDrift(db, budgeted(2048));
      expect(report.unresolvable).toEqual([]);
      expect(report.stale.flatMap((entry) => entry.pages)).toHaveLength(70);
    });

    test("one run that uses nothing, between two drifts, still places all 10 cited revisions", async () => {
      for (let run = 0; run < 10; run++) {
        Bun.sleepSync(5);
        write("a.md", String(run), 1000 + run);
        verify(db, `p${run}.md`, (await detectDrift(db, budgeted(1))).currentRevision!);
      }
      // An overlapping or aborted run: it starts, and reads nothing.
      Bun.sleepSync(5);
      await budgeted(1).revision();

      Bun.sleepSync(5);
      write("a.md", "after", 5000);
      const report = await detectDrift(db, budgeted(1));
      expect(report.unresolvable).toEqual([]);
      expect(report.stale.flatMap((entry) => entry.pages)).toHaveLength(10);
    });

    test("a snapshot is never dated before the run that wrote it", async () => {
      // Linux CI dated a write 0.39 ms before its own run's marker, which left it unprotected.
      for (let run = 0; run < 50; run++) {
        write("a.md", String(run), 1000 + run);
        const revision = await persisted().revision();
        const written = statSync(snapshotFile(revision), { bigint: true }).mtimeNs;
        expect(written).toBeGreaterThanOrEqual(statSync(marker(), { bigint: true }).mtimeNs);
      }
    });

    test("re-verified every run, each run uses 2 and two runs keep at most 4", async () => {
      for (let run = 0; run < 10; run++) {
        // The marker has millisecond resolution; real runs are further apart than this.
        Bun.sleepSync(5);
        write("a.md", String(run), 1000 + run);
        const report = await detectDrift(db, budgeted(1));
        expect(report.unresolvable).toEqual([]);
        for (const page of ["p1.md", "p2.md", "p3.md"]) verify(db, page, report.currentRevision!);
        if (run < 2) continue;

        const since = statSync(marker()).mtimeMs;
        const files = readdirSync(snapshots()).filter((name) => name.endsWith(".json"));
        const used = files.filter((name) => statSync(join(snapshots(), name)).mtimeMs >= since);
        expect(used).toHaveLength(2);
        expect(files.length).toBeLessThanOrEqual(4);
      }
    });

    const seed = async (budget: (snapshotSize: number) => number) => {
      write("a.md", "one", 1000);
      const revision = await persisted().revision();
      const since = statSync(marker()).mtimeMs;
      const dummy = (i: number, ms: number) => {
        const file = join(snapshots(), `${i.toString(16).padStart(12, "0")}.json`);
        writeFileSync(file, "x".repeat(100));
        setTime(file, ms);
        return basename(file);
      };
      const unused = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => dummy(i, since - 100_000 + i * 1000));
      const used = [8, 9].map((i) => dummy(i, since + 1));
      const size = statSync(snapshotFile(revision)).size;
      await budgeted(budget(size)).revision();
      return { revision, unused, used, kept: readdirSync(snapshots()) };
    };

    test("over budget, unused snapshots go oldest first until it fits", async () => {
      const { revision, unused, used, kept } = await seed((size) => size + 500);
      expect(kept).toContain(`${revision}.json`);
      for (const name of used) expect(kept).toContain(name);
      for (const name of unused.slice(0, 5)) expect(kept).not.toContain(name);
      for (const name of unused.slice(5)) expect(kept).toContain(name);
    });

    test("snapshots the last run used are kept even when they alone exceed the budget", async () => {
      const { revision, unused, used, kept } = await seed(() => 1);
      expect(kept).toContain(`${revision}.json`);
      for (const name of used) expect(kept).toContain(name);
      for (const name of unused) expect(kept).not.toContain(name);
    });
  });

  test("concurrent sessions on one revision leave one whole snapshot and no staging files", async () => {
    write("a.md", "one", 1000);
    const revision = await persisted().revision();
    const module = join(import.meta.dir, "..", "src", "index.ts");
    const script = `
      const { FsSource } = await import(${JSON.stringify(module)});
      const open = () => new FsSource({ id: "docs", root: ${JSON.stringify(root)},
        citationFormat: "{rev}", stateDir: ${JSON.stringify(state)} });
      let failures = 0;
      for (let i = 0; i < 50; i++) {
        await open().revision();
        try { await open().changedSince(${JSON.stringify(revision)}); } catch { failures++; }
      }
      console.log(failures);
    `;
    const procs = Array.from({ length: 6 }, () =>
      Bun.spawn([process.execPath, "-e", script], { stdout: "pipe", stderr: "pipe" }),
    );
    const failures = await Promise.all(
      procs.map(async (p) => {
        await p.exited;
        return (await new Response(p.stdout).text()).trim();
      }),
    );

    expect(failures).toEqual(Array(6).fill("0"));
    expect(readdirSync(snapshots()).toSorted()).toEqual([
      ".gitignore",
      ".last-run",
      ".prev-run",
      `${revision}.json`,
    ]);
  });
});

/** Names, bytes and mtimes: what a prune or a stray write would change. */
const fingerprint = (dir: string) =>
  readdirSync(dir, { recursive: true })
    .map(String)
    .toSorted()
    .map((name) => {
      const stat = lstatSync(join(dir, name));
      return [name, stat.isFile() ? readFileSync(join(dir, name), "utf-8") : "", stat.mtimeMs];
    });

describe("FsSource snapshots in a hostile state directory", () => {
  let base = "";
  let victim = "";
  const OLD = 1_000_000;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "accreta-fs-hostile-"));
    victim = join(base, "victim-notes");
    mkdirSync(victim);
    // Old and named like snapshots, so an unguarded prune would take every one.
    for (let i = 0; i < 100; i++) {
      const file = join(victim, `${i.toString(16).padStart(12, "0")}.json`);
      writeFileSync(file, `note ${i}`);
      utimesSync(file, OLD, OLD);
    }
    write("a.md", "one", 1000);
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  const adapter = (stateDir: string) =>
    new FsSource({ id: "docs", root, citationFormat: "{rev}", stateDir });

  const symlinked = {
    "the source's snapshot directory": (state: string) => {
      mkdirSync(join(state, "fs-snapshots"), { recursive: true });
      symlinkSync(victim, snapshotDirFor(state, "docs"));
      return state;
    },
    "fs-snapshots": (state: string) => {
      mkdirSync(state, { recursive: true });
      mkdirSync(join(victim, basename(snapshotDirFor(state, "docs"))));
      symlinkSync(victim, join(state, "fs-snapshots"));
      return state;
    },
    ".accreta": (state: string) => {
      mkdirSync(join(victim, "fs-snapshots", basename(snapshotDirFor(state, "docs"))), {
        recursive: true,
      });
      mkdirSync(dirname(state), { recursive: true });
      symlinkSync(victim, state);
      return state;
    },
  };

  for (const [what, plant] of Object.entries(symlinked)) {
    test(`a symlinked ${what} is never written, read or pruned`, async () => {
      const state = plant(join(base, "kb", ".accreta"));
      const before = fingerprint(victim);

      const verifiedAt = await adapter(state).revision();
      write("a.md", "two", 2000);

      expect(fingerprint(victim)).toEqual(before);
      expect(adapter(state).changedSince(verifiedAt)).rejects.toThrow(UnknownRevisionError);
    });
  }

  test("prune removes only its own regular files, and a stray entry cannot fail drift", async () => {
    const state = join(base, "state");
    const dir = snapshotDirFor(state, "docs");
    const first = await adapter(state).revision();
    mkdirSync(join(dir, "stray"));
    mkdirSync(join(dir, "000000000000.json"));
    symlinkSync(join(victim, "000000000001.json"), join(dir, "000000000001.json"));
    writeFileSync(join(dir, "notes.txt"), "mine");
    writeFileSync(join(dir, "000000000002.json"), "{}");
    for (const name of ["stray", "000000000000.json", "notes.txt", "000000000002.json"]) {
      utimesSync(join(dir, name), OLD, OLD);
    }
    const before = fingerprint(victim);

    write("a.md", "two", 2000);
    const second = await new FsSource({
      id: "docs",
      root,
      citationFormat: "{rev}",
      stateDir: state,
      snapshotBudgetBytes: 1,
    }).revision();

    const kept = [".gitignore", ".last-run", ".prev-run", "000000000000.json", "000000000001.json"];
    const mine = [`${first}.json`, `${second}.json`, "notes.txt", "stray"];
    expect(readdirSync(dir).toSorted()).toEqual([...kept, ...mine].toSorted());
    expect(fingerprint(victim)).toEqual(before);
  });

  const unreadable = {
    "a FIFO": (file: string) => {
      expect(Bun.spawnSync(["mkfifo", file]).exitCode).toBe(0);
    },
    "a symlink to /dev/zero": (file: string) => symlinkSync("/dev/zero", file),
    "a file past the size limit": (file: string) => {
      writeFileSync(file, "");
      truncateSync(file, SNAPSHOT_MAX_BYTES + 1);
    },
  };

  for (const [what, plant] of Object.entries(unreadable)) {
    test(`${what} in place of a snapshot is an unknown revision, at once`, async () => {
      const state = join(base, "state");
      const verifiedAt = await adapter(state).revision();
      const file = join(snapshotDirFor(state, "docs"), `${verifiedAt}.json`);
      rmSync(file);
      plant(file);

      const started = performance.now();
      expect(adapter(state).changedSince(verifiedAt)).rejects.toThrow(UnknownRevisionError);
      expect(performance.now() - started).toBeLessThan(100);
    });
  }

  test("a listing forged through NUL in a path does not pass for the real one", async () => {
    write("b.md", "two", 2000);
    const state = join(base, "state");
    const verifiedAt = await adapter(state).revision();
    const file = join(snapshotDirFor(state, "docs"), `${verifiedAt}.json`);
    const [a, b] = ["a.md", "b.md"].map((name) => statSync(join(root, name)).mtimeMs);
    const forged = [[`a.md\u0000${a}\u0000b.md`, b]];
    const sameHash = createHash("sha256").update(`a.md\u0000${a}\u0000b.md\u0000${b}\u0000`);
    expect(sameHash.digest("hex").slice(0, 12)).toBe(verifiedAt);
    writeFileSync(file, JSON.stringify({ format: 1, revision: verifiedAt, entries: forged }));

    expect(adapter(state).changedSince(verifiedAt)).rejects.toThrow(UnknownRevisionError);
  });
});
