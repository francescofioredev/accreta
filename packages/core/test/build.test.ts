import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

  test("the rebuild leaves no staging file behind", () => {
    writePage("a.md", "# A\n");
    build();
    expect(existsSync(`${indexPath}.building`)).toBe(false);
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

  test("a connection held across a swap fails loudly instead of serving stale rows", () => {
    // Worth pinning down, because the tempting claim — that an in-flight reader
    // keeps its old inode and finishes undisturbed — is not what SQLite does.
    // It revalidates the file behind the handle and fails with SQLITE_IOERR.
    // A caller must reopen after a rebuild. Loud beats silently stale.
    writePage("a.md", "# A\n");
    build();

    const stale = openIndex(indexPath, { readonly: true });
    expect(stale.query("SELECT COUNT(*) AS n FROM pages").get()).toEqual({ n: 1 });

    writePage("b.md", "# B\n");
    build();

    expect(() => stale.query("SELECT COUNT(*) AS n FROM pages").get()).toThrow();
    stale.close();
  });
});
