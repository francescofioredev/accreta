// Checks that the runtime's built-in SQLite does everything accreta's index relies on (ADR-0016).
// Run with `node` or `bun`: node:sqlite on both, `--driver=bun` for bun:sqlite.
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const isBun = typeof globalThis.Bun !== "undefined";
const runtime = isBun ? `bun ${globalThis.Bun.version}` : `node ${process.version}`;

const driver = process.argv.includes("--driver=bun")
  ? await (async () => {
      const { Database } = await import("bun:sqlite");
      return {
        name: "bun:sqlite",
        open: (path, readonly) =>
          new Database(path, readonly ? { readonly: true } : { create: true }),
      };
    })()
  : await (async () => {
      const { DatabaseSync } = await import("node:sqlite");
      return {
        name: "node:sqlite",
        open: (path, readonly) => new DatabaseSync(path, readonly ? { readOnly: true } : {}),
      };
    })();

const schema = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../../packages/core/src/index-db/schema.sql"),
  "utf-8",
);
const dir = mkdtempSync(join(tmpdir(), "accreta-0016-"));
const results = [];

function check(name, fn) {
  try {
    const detail = fn();
    results.push({ name, ok: true, detail });
  } catch (error) {
    results.push({ name, ok: false, detail: String(error?.message ?? error) });
  }
}

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

// Mirrors openIndex() in packages/core/src/index-db/db.ts.
function openIndex(path, readonly = false) {
  const db = driver.open(path, readonly);
  if (!readonly) {
    db.exec("PRAGMA journal_mode = WAL");
    db.exec(schema);
  }
  db.exec("PRAGMA foreign_keys = ON");
  return db;
}

// Mirrors sealForReading().
function seal(db) {
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  db.exec("PRAGMA journal_mode = DELETE");
}

// Mirrors the insert in build.ts, `$`-prefixed keys included.
function insertPage(db, path, title, body, aliases = "") {
  db.prepare(
    `INSERT INTO pages (path, type, title, frontmatter_json, body, mtime)
     VALUES ($path, $type, $title, $fm, $body, $mtime)`,
  ).run({
    $path: path,
    $type: "note",
    $title: title,
    $fm: "{}",
    $body: body,
    $mtime: 1756000000000,
  });
  db.prepare(
    `INSERT INTO pages_fts (title, aliases, body, path, type, source)
     VALUES ($title, $aliases, $body, $path, $type, $source)`,
  ).run({ $title: title, $aliases: aliases, $body: body, $path: path, $type: "note", $source: "" });
}

function inodeOf(path) {
  const s = statSync(path);
  return `${s.dev}:${s.ino}`;
}

// Mirrors buildIndex(): stage beside the target, seal, rename over it.
function build(livePath, pages) {
  const staging = `${livePath}.building.${process.pid}.${Math.random().toString(36).slice(2)}`;
  const db = openIndex(staging);
  db.exec("BEGIN");
  for (const [path, title, body] of pages) insertPage(db, path, title, body);
  db.exec("COMMIT");
  seal(db);
  db.close();
  renameSync(staging, livePath);
  for (const suffix of ["-wal", "-shm"]) rmSync(`${staging}${suffix}`, { force: true });
}

let sqliteVersion = "?";

check("environment", () => {
  const db = driver.open(":memory:", false);
  sqliteVersion = db.prepare("SELECT sqlite_version() AS v").get().v;
  const options = db
    .prepare("PRAGMA compile_options")
    .all()
    .map((r) => r.compile_options);
  db.close();
  return `${runtime}, ${driver.name}, SQLite ${sqliteVersion}, ENABLE_FTS5=${options.includes("ENABLE_FTS5")}`;
});

check("fts5: schema.sql pages_fts, porter unicode61, search.ts query shape", () => {
  const db = openIndex(join(dir, "fts.sqlite"));
  insertPage(db, "kb/a.md", "Rebuilding indexes", "The index is rebuilt at the café.", "reindex");
  insertPage(db, "kb/b.md", "Unrelated", "Nothing to see here.");
  const search = (q) =>
    db
      .prepare(
        `SELECT p.path AS path, snippet(pages_fts, 2, '<<', '>>', ' … ', 16) AS snippet
         FROM pages_fts JOIN pages p ON p.path = pages_fts.path
         WHERE pages_fts MATCH ? AND p.type IN (?) ORDER BY rank LIMIT ?`,
      )
      .all(q, "note", 10);
  const stemmed = search("rebuild");
  const diacritic = search("cafe");
  const alias = search("aliases:reindex");
  db.close();
  assert(stemmed.length === 1 && stemmed[0].path === "kb/a.md", "porter stemming: rebuild");
  assert(diacritic.length === 1, "unicode61 diacritic folding: cafe");
  assert(alias.length === 1, "column filter on aliases");
  return `rebuild→${stemmed[0].path}, cafe→${diacritic.length} hit, snippet=${JSON.stringify(stemmed[0].snippet)}`;
});

check("wal: journal_mode=WAL returns wal on a file DB", () => {
  const db = driver.open(join(dir, "wal.sqlite"), false);
  const mode = db.prepare("PRAGMA journal_mode = WAL").get().journal_mode;
  db.close();
  assert(mode === "wal", `got ${mode}`);
  return `journal_mode=${mode}`;
});

// Informational: accreta's readers only ever open the sealed file, never one being written.
check("wal (informational): a second connection reads during an open write", () => {
  const path = join(dir, "wal2.sqlite");
  const writer = openIndex(path);
  insertPage(writer, "kb/one.md", "One", "first");
  const reader = openIndex(path, true);
  const count = () => reader.prepare("SELECT COUNT(*) AS n FROM pages").get().n;
  writer.exec("BEGIN IMMEDIATE");
  insertPage(writer, "kb/two.md", "Two", "second");
  const during = count();
  writer.exec("COMMIT");
  const after = count();
  reader.close();
  writer.close();
  assert(during === 1 && after === 2, `during=${during} after=${after}`);
  return `reader saw ${during} row during the uncommitted write, ${after} after commit`;
});

check("wal: sealForReading leaves DELETE mode; readonly open works", () => {
  const path = join(dir, "seal.sqlite");
  const db = openIndex(path);
  insertPage(db, "kb/one.md", "One", "first");
  seal(db);
  const mode = db.prepare("PRAGMA journal_mode").get().journal_mode;
  db.close();
  const sidecars = ["-wal", "-shm"].filter((s) => existsSync(`${path}${s}`));
  const ro = openIndex(path, true);
  const n = ro.prepare("SELECT COUNT(*) AS n FROM pages").get().n;
  let writeRefused = false;
  try {
    ro.exec("DELETE FROM pages");
  } catch {
    writeRefused = true;
  }
  ro.close();
  // Leftover sidecars are informational: build.ts removes the staging ones after the rename.
  assert(mode === "delete", `mode=${mode}`);
  assert(n === 1 && writeRefused, `n=${n} writeRefused=${writeRefused}`);
  return `journal_mode=${mode}, sidecars left=${JSON.stringify(sidecars)}, readonly read=${n}, readonly write refused`;
});

check("api: statement surface db.ts and its callers use", () => {
  const db = openIndex(join(dir, "api.sqlite"));
  insertPage(db, "kb/one.md", "One", "first");
  const hit = db.prepare("SELECT path, mtime FROM pages WHERE path = ?").get("kb/one.md");
  const miss = db.prepare("SELECT path FROM pages WHERE path = ?").get("kb/none.md");
  const rows = db.prepare("SELECT path FROM pages WHERE path IN (?, ?)").all("kb/one.md", "x");
  const run = db.prepare("DELETE FROM pages WHERE path = ?").run("x");
  const fk = db.prepare("PRAGMA foreign_keys").get().foreign_keys;
  const hasQuery = typeof db.query === "function";
  db.close();
  assert(hit.path === "kb/one.md" && rows.length === 1 && fk === 1, "basic statement calls");
  return [
    `get(miss)=${miss === null ? "null" : String(miss)}`,
    `mtime is ${typeof hit.mtime}`,
    `row prototype ${Object.getPrototypeOf(hit) === null ? "null" : "Object"}`,
    `run() returns ${JSON.stringify(Object.keys(run))}`,
    `db.query ${hasQuery ? "exists" : "absent"}`,
  ].join(", ");
});

check("api: prepare cost, since node:sqlite has no statement cache", () => {
  const db = openIndex(join(dir, "cost.sqlite"));
  const sql = `SELECT p.path AS path FROM pages_fts JOIN pages p ON p.path = pages_fts.path
               WHERE pages_fts MATCH ? ORDER BY rank LIMIT ?`;
  const n = 10000;
  const started = performance.now();
  for (let i = 0; i < n; i++) db.prepare(sql);
  const us = ((performance.now() - started) * 1000) / n;
  db.close();
  return `${us.toFixed(1)}µs per prepare of the search query (mean of ${n})`;
});

check("swap: ADR-0010 rename over a live index, held reader, inode revalidation", () => {
  const live = join(dir, "index.sqlite");
  build(live, [["kb/old.md", "Old", "before the rebuild"]]);
  const held = openIndex(live, true);
  const heldInode = inodeOf(live);
  const before = held
    .prepare("SELECT path FROM pages")
    .all()
    .map((r) => r.path);

  build(live, [["kb/new.md", "New", "after the rebuild"]]);
  let heldOutcome;
  try {
    const rows = held
      .prepare("SELECT path FROM pages")
      .all()
      .map((r) => r.path);
    heldOutcome = `served ${JSON.stringify(rows)} (stale, Linux-style)`;
  } catch (error) {
    heldOutcome = `threw "${error.message}" (macOS-style)`;
  }

  const changed = inodeOf(live) !== heldInode;
  const reopened = openIndex(live, true);
  const after = reopened
    .prepare("SELECT path FROM pages")
    .all()
    .map((r) => r.path);
  reopened.close();
  held.close();
  assert(before[0] === "kb/old.md", "reader saw the first build");
  assert(changed, "rename did not change dev:ino");
  assert(after.length === 1 && after[0] === "kb/new.md", `reopened saw ${after}`);
  return `held reader ${heldOutcome}; dev:ino changed=${changed}; reopened reader saw ${JSON.stringify(after)}`;
});

rmSync(dir, { recursive: true, force: true });

for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}\n      ${r.detail}`);
const failed = results.filter((r) => !r.ok).length;
console.log(
  `\n${results.length - failed}/${results.length} passed on ${runtime} (SQLite ${sqliteVersion})`,
);
process.exitCode = failed ? 1 : 0;
