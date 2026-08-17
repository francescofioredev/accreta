import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { DEFAULT_CONFIG, type AccretaConfig } from "../src/config.ts";
import { buildIndex } from "../src/index-db/build.ts";
import { openIndex } from "../src/index-db/db.ts";

let root = "";
let indexPath = "";

const config: AccretaConfig = {
  ...DEFAULT_CONFIG,
  knowledgeBase: "knowledge",
  linkFields: ["related", "discussed_in"],
};

function writePage(relativePath: string, contents: string): void {
  const full = join(root, "knowledge", relativePath);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, contents, "utf-8");
}

function build() {
  return buildIndex({ root, config, indexPath });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "accreta-test-"));
  indexPath = join(root, ".index", "accreta.sqlite");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("buildIndex", () => {
  test("an absent knowledge base indexes as empty rather than throwing", () => {
    const result = build();
    expect(result.pages).toBe(0);
  });

  test("pages are indexed with their frontmatter and body", () => {
    writePage("concepts/forcing.md", "---\ntype: concept\n---\n\n# Radiative forcing\n\nProse.\n");
    expect(build().pages).toBe(1);

    const db = openIndex(indexPath, { readonly: true });
    const row = db.query("SELECT * FROM pages").get() as Record<string, unknown>;
    expect(row.path).toBe("knowledge/concepts/forcing.md");
    expect(row.type).toBe("concept");
    expect(row.title).toBe("Radiative forcing");
    expect(JSON.parse(row.frontmatter_json as string)).toEqual({ type: "concept" });
    db.close();
  });

  // The end-to-end half of the quoted-wikilink defect. Parsing is asserted in
  // page.test.ts; what mattered in practice is that the *indexed row* lost its
  // provenance, because that is the row drift and lint read. A page that cites
  // nothing can never be flagged as having drifted.
  test("a quoted wikilink in the title does not cost the page its provenance", () => {
    writePage(
      "concepts/forcing.md",
      '---\ntitle: "Radiative forcing, see also [[concepts/sensitivity]]"\ntype: concept\ncanonical_source: "ipcc:ch07.md#L320"\nlast_verified_revision: 9a4f2c1\n---\n\n# Radiative forcing\n',
    );
    writePage("concepts/sensitivity.md", "---\ntype: concept\n---\n\n# Sensitivity\n");
    build();

    const db = openIndex(indexPath, { readonly: true });
    const row = db
      .query("SELECT type, canonical_source, last_verified_revision FROM pages WHERE path = ?")
      .get("knowledge/concepts/forcing.md") as Record<string, unknown>;
    expect(row.type).toBe("concept");
    expect(row.canonical_source).toBe("ipcc:ch07.md#L320");
    expect(row.last_verified_revision).toBe("9a4f2c1");
    db.close();
  });

  test("nested directories are walked", () => {
    writePage("a.md", "# A\n");
    writePage("deep/b.md", "# B\n");
    writePage("deep/deeper/c.md", "# C\n");
    expect(build().pages).toBe(3);
  });

  test("typed and inline links both land in the graph", () => {
    writePage("a.md", "---\nrelated: [[b]]\n---\n\n# A\n\nSee [[c]].\n");
    writePage("b.md", "# B\n");
    writePage("c.md", "# C\n");

    build();
    const db = openIndex(indexPath, { readonly: true });
    const rows = db.query("SELECT src_path, dst_path, kind FROM links ORDER BY kind").all();
    expect(rows).toEqual([
      { src_path: "knowledge/a.md", dst_path: "knowledge/b.md", kind: "related" },
      { src_path: "knowledge/a.md", dst_path: "knowledge/c.md", kind: "wikilink" },
    ]);
    db.close();
  });

  test("a '..' link resolves to the same edge as the direct form", () => {
    // The regression from #10, now asserted at the level that actually matters:
    // the arc exists in the graph.
    writePage("concepts/x.md", "# X\n\nSee [[../modules/foo]].\n");
    writePage("modules/foo.md", "# Foo\n");

    build();
    const db = openIndex(indexPath, { readonly: true });
    const row = db.query("SELECT dst_path FROM links").get() as { dst_path: string };
    expect(row.dst_path).toBe("knowledge/modules/foo.md");
    db.close();
  });

  test("an unresolvable link is recorded rather than dropped", () => {
    writePage("a.md", "# A\n\nSee [[../../../etc/passwd]].\n");

    const result = build();
    expect(result.brokenLinks).toBe(1);
    expect(result.links).toBe(0);

    const db = openIndex(indexPath, { readonly: true });
    const row = db.query("SELECT * FROM broken_links").get() as Record<string, unknown>;
    expect(row.src_path).toBe("knowledge/a.md");
    expect(row.reason).toBe("escapes-knowledge-base");
    db.close();
  });

  test("full-text search finds a page by its body", () => {
    writePage("a.md", "---\ntype: concept\n---\n\n# Radiative forcing\n\ntropopause flux\n");
    writePage("b.md", "---\ntype: note\n---\n\n# Unrelated\n\nsomething else\n");

    build();
    const db = openIndex(indexPath, { readonly: true });
    const rows = db.query("SELECT path FROM pages_fts WHERE pages_fts MATCH ?").all("tropopause");
    expect(rows).toEqual([{ path: "knowledge/a.md" }]);
    db.close();
  });

  test("a rebuild replaces the previous contents rather than accumulating", () => {
    writePage("a.md", "# A\n");
    expect(build().pages).toBe(1);

    writePage("b.md", "# B\n");
    expect(build().pages).toBe(2);

    const db = openIndex(indexPath, { readonly: true });
    const { n } = db.query("SELECT COUNT(*) AS n FROM pages").get() as { n: number };
    expect(n).toBe(2);
    db.close();
  });

  test("a deleted page is gone after a rebuild", () => {
    writePage("a.md", "# A\n");
    writePage("b.md", "# B\n");
    build();

    rmSync(join(root, "knowledge", "b.md"));
    expect(build().pages).toBe(1);

    const db = openIndex(indexPath, { readonly: true });
    const rows = db.query("SELECT path FROM pages").all();
    expect(rows).toEqual([{ path: "knowledge/a.md" }]);
    db.close();
  });

  test("a page whose frontmatter will not parse is still indexed", () => {
    writePage("a.md", "---\ntype: [unclosed\n---\n\n# Still here\n");
    expect(build().pages).toBe(1);

    const db = openIndex(indexPath, { readonly: true });
    const row = db.query("SELECT type, title FROM pages").get() as Record<string, unknown>;
    expect(row.type).toBe("unknown");
    expect(row.title).toBe("Still here");
    db.close();
  });

  test("which frontmatter fields are links is decided by configuration", () => {
    writePage("a.md", "---\ncites: [[b]]\n---\n\n# A\n");
    writePage("b.md", "# B\n");

    expect(build().links).toBe(0);

    const citing = { ...config, linkFields: ["cites"] };
    expect(buildIndex({ root, config: citing, indexPath }).links).toBe(1);
  });

  test("a sealed index is left in a mode a read-only connection can open", () => {
    // The incident behind sealForReading(): a served index is only ever read,
    // and a read-only connection cannot create the -shm file a WAL database
    // needs. Leaving the index in WAL mode is what turns it into "unable to
    // open database file". The WAL is also truncated, because it is never
    // checkpointed otherwise and grows unbounded.
    writePage("a.md", "# A\n");
    build();

    expect(Bun.file(`${indexPath}-wal`).size).toBe(0);

    // Sidecars are not shipped alongside a served index, so the real test is
    // that the database opens read-only without them.
    for (const suffix of ["-wal", "-shm"]) {
      rmSync(`${indexPath}${suffix}`, { force: true });
    }

    const db = openIndex(indexPath, { readonly: true });
    const mode = db.query("PRAGMA journal_mode").get() as { journal_mode: string };
    expect(mode.journal_mode).toBe("delete");
    expect(db.query("SELECT COUNT(*) AS n FROM pages").get()).toEqual({ n: 1 });
    db.close();
  });

  test("meta records the page count and the knowledge base it indexed", () => {
    writePage("a.md", "# A\n");
    build();

    const db = openIndex(indexPath, { readonly: true });
    const rows = db.query("SELECT key, value FROM meta").all() as { key: string; value: string }[];
    const meta = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    expect(meta.page_count).toBe("1");
    expect(meta.knowledge_base).toBe("knowledge");
    db.close();
  });

  /** Staging names carry a pid and a UUID, so this globs rather than guessing one. */
  function stagingLeftovers(): string[] {
    const prefix = `${basename(indexPath)}.building`;
    return readdirSync(dirname(indexPath)).filter((name) => name.startsWith(prefix));
  }

  test("the rebuild leaves no staging file behind", () => {
    writePage("a.md", "# A\n");
    build();
    expect(stagingLeftovers()).toEqual([]);
  });

  test("a failed rebuild leaves no staging file behind either", () => {
    writePage("a.md", "# A\n");
    // A unique staging name is never reused, so a leak is permanent rather than
    // overwritten by the next run. An unreadable page fails the scan mid-build.
    const unreadable = join(root, "knowledge", "locked.md");
    writeFileSync(unreadable, "# L\n", "utf-8");
    chmodSync(unreadable, 0o000);
    try {
      expect(() => build()).toThrow();
      expect(stagingLeftovers()).toEqual([]);
    } finally {
      chmodSync(unreadable, 0o644);
    }
  });

  test("two concurrent rebuilds both survive, and the winner's index is whole", async () => {
    // Two sessions reindexing one knowledge base is the tool's own loop. Under
    // a fixed staging name the slow one died with "disk I/O error" and the
    // index kept only the fast one's pages, passing integrity_check.
    //
    // The corpus is large enough that a build outlasts bun's startup jitter:
    // both children are spawned together and synchronise on a start file, so
    // their staging windows genuinely overlap rather than merely being asked to.
    const PAGES = 2000;
    for (let i = 0; i < PAGES; i++) writePage(`p${i}.md`, `# P${i}\n\nbody ${i}\n`);

    const script = join(root, "build.ts");
    writeFileSync(
      script,
      `import { buildIndex } from ${JSON.stringify(join(import.meta.dir, "../src/index-db/build.ts"))};\n` +
        `const [root, indexPath, gate] = process.argv.slice(2);\n` +
        `while (!(await Bun.file(gate).exists())) await Bun.sleep(1);\n` +
        `buildIndex({ root, indexPath, config: ${JSON.stringify(config)} });\n`,
      "utf-8",
    );

    const gate = join(root, "go");
    const spawn = () =>
      Bun.spawn(["bun", script, root, indexPath, gate], { stderr: "pipe" });
    const children = [spawn(), spawn()];
    await Bun.sleep(300);
    writeFileSync(gate, "", "utf-8");

    const codes = await Promise.all(children.map((c) => c.exited));
    const stderrs = await Promise.all(children.map((c) => new Response(c.stderr).text()));
    expect(`${codes.join(",")} ${stderrs.join(" ")}`).toBe("0,0  ");

    const db = openIndex(indexPath, { readonly: true });
    expect(db.query("SELECT COUNT(*) AS n FROM pages").get()).toEqual({ n: PAGES });
    db.close();
    expect(stagingLeftovers()).toEqual([]);
  });

  test("a rebuild swaps in the new index atomically", () => {
    // rename(2) guarantees no reader ever opens a half-rebuilt index: the path
    // names the whole old database or the whole new one.
    writePage("a.md", "# A\n");
    build();

    const before = openIndex(indexPath, { readonly: true });
    expect(before.query("SELECT COUNT(*) AS n FROM pages").get()).toEqual({ n: 1 });
    before.close();

    writePage("b.md", "# B\n");
    build();

    const after = openIndex(indexPath, { readonly: true });
    expect(after.query("SELECT COUNT(*) AS n FROM pages").get()).toEqual({ n: 2 });
    after.close();
  });

  test("a reopened connection sees the new index after a swap", () => {
    // What a caller may rely on: reopen after a rebuild and you get the new
    // data. What it may *not* rely on is the fate of a handle held across the
    // swap — that is platform-dependent. On Linux the unlinked inode stays
    // alive behind the open descriptor and the stale handle keeps serving the
    // old rows; on macOS SQLite revalidates the file and fails the connection
    // with SQLITE_IOERR. Neither is asserted here, because pinning either one
    // would encode one platform's filesystem semantics as a promise.
    writePage("a.md", "# A\n");
    build();

    const first = openIndex(indexPath, { readonly: true });
    expect(first.query("SELECT COUNT(*) AS n FROM pages").get()).toEqual({ n: 1 });
    first.close();

    writePage("b.md", "# B\n");
    build();

    const second = openIndex(indexPath, { readonly: true });
    expect(second.query("SELECT COUNT(*) AS n FROM pages").get()).toEqual({ n: 2 });
    second.close();
  });
});
