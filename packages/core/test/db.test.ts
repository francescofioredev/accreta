import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openIndex, sqliteSupport } from "../src/index-db/db.ts";

let root = "";
let indexPath = "";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "accreta-db-"));
  indexPath = join(root, "index.sqlite");
  openIndex(indexPath).close();
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

test("the runtime running this suite has FTS5", () => {
  expect(sqliteSupport()).toBeNull();
});
