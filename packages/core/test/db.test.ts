import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  IndexUnreadableError,
  openIndex,
  sealForReading,
  sqliteSupport,
} from "../src/index-db/db.ts";
import { INDEX_FORMAT, INDEX_FORMAT_KEY } from "../src/index-db/format.ts";

let root = "";
let indexPath = "";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "accreta-db-"));
  indexPath = join(root, "index.sqlite");
  const writer = openIndex(indexPath);
  // A reader refuses an index with no format, and this one is built by hand.
  writer
    .prepare("INSERT INTO meta (key, value) VALUES ($key, $value)")
    .run({ $key: INDEX_FORMAT_KEY, $value: String(INDEX_FORMAT) });
  // Sealed as the build seals it: a reader cannot open a WAL index once its `-shm` is gone.
  sealForReading(writer);
  writer.close();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

// node:sqlite ignores Bun's spelling, `readonly`, and would leave this reader writable.
test("a write through a read-only open is refused", () => {
  const db = openIndex(indexPath, { readonly: true });
  try {
    expect(() => db.exec("DELETE FROM pages")).toThrow("attempt to write a readonly database");
  } finally {
    db.close();
  }
});

test("a writer can write", () => {
  const db = openIndex(indexPath);
  try {
    db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)").run("k", "v");
    expect(db.prepare("SELECT value FROM meta WHERE key = ?").get("k")).toEqual({ value: "v" });
  } finally {
    db.close();
  }
});

test("no row is undefined, not null", () => {
  const db = openIndex(indexPath, { readonly: true });
  try {
    expect(db.prepare("SELECT value FROM meta WHERE key = ?").get("absent")).toBeUndefined();
  } finally {
    db.close();
  }
});

test("a reader that cannot open the file gets SQLite's reason and the remedy, not a missing FTS5", () => {
  // Portable stand-in for an unsealed WAL index on Bun 1.4.4/macOS: the open succeeds, the first read fails.
  writeFileSync(indexPath, "not a database, but long enough to have a header to reject".repeat(4));
  let failure: unknown;
  try {
    openIndex(indexPath, { readonly: true }).close();
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(IndexUnreadableError);
  expect((failure as Error).message).toContain("file is not a database");
  expect((failure as Error).message).toContain("run `accreta reindex`");
});

test("the runtime running this suite has FTS5", () => {
  expect(sqliteSupport()).toBeNull();
});
