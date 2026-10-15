import { afterEach, beforeEach, expect, test } from "bun:test";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { buildIndex } from "../src/index-db/build.ts";
import { openIndex, type Database } from "../src/index-db/db.ts";
import { checkFormat, INDEX_FORMAT, requireIndexFormat } from "../src/index-db/format.ts";
import { StaleIndexError } from "../src/query/tables.ts";

let root = "";
let indexPath = "";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "accreta-format-"));
  indexPath = join(root, ".accreta", "index.sqlite");
  mkdirSync(join(root, "knowledge"), { recursive: true });
  writeFileSync(join(root, "knowledge", "a.md"), "---\ntype: note\n---\n\n# A\n", "utf-8");
  buildIndex({ root, config: { ...DEFAULT_CONFIG, knowledgeBase: "knowledge" }, indexPath });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function tamper(sql: string): void {
  const writable = new DatabaseSync(indexPath);
  try {
    writable.exec(sql);
  } finally {
    writable.close();
  }
}

function setFormat(value: string): void {
  const writable = new DatabaseSync(indexPath);
  try {
    writable
      .prepare(
        `INSERT INTO meta (key, value) VALUES ($key, $value)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run({ $key: "index_format", $value: value });
  } finally {
    writable.close();
  }
}

function refusal(): unknown {
  try {
    openIndex(indexPath, { readonly: true }).close();
  } catch (error) {
    return error;
  }
  return undefined;
}

test("a freshly built index records the current format and opens", () => {
  const writable = new DatabaseSync(indexPath);
  const row = writable
    .prepare("SELECT value FROM meta WHERE key = $key")
    .get({ $key: "index_format" }) as { value: string } | undefined;
  writable.close();
  expect(row?.value).toBe(String(INDEX_FORMAT));
  expect(refusal()).toBeUndefined();
});

test("an index with the previous format is refused by name", () => {
  setFormat(String(INDEX_FORMAT - 1));
  const error = refusal();
  expect(error).toBeInstanceOf(StaleIndexError);
  expect((error as Error).name).toBe("StaleIndexError");
  expect((error as Error).message).toContain("run `accreta reindex`");
});

test("an index with no format is refused by name", () => {
  tamper("DELETE FROM meta WHERE key = 'index_format'");
  const error = refusal();
  expect(error).toBeInstanceOf(StaleIndexError);
  expect((error as Error).name).toBe("StaleIndexError");
  expect((error as Error).message).toContain("run `accreta reindex`");
});

test("an index with no meta table is refused by name", () => {
  tamper("DROP TABLE meta");
  expect(refusal()).toBeInstanceOf(StaleIndexError);
});

test("an index built by a newer accreta is refused and says so", () => {
  setFormat(String(INDEX_FORMAT + 1));
  const error = refusal();
  expect(error).toBeInstanceOf(StaleIndexError);
  expect((error as Error).message).toContain("newer accreta");
});

test("checkFormat tells an older, a newer and a missing format apart", () => {
  expect(checkFormat("10", 10)).toEqual({ kind: "current" });
  expect(checkFormat("9", 10)).toEqual({ kind: "older", found: 9 });
  expect(checkFormat("10", 9)).toEqual({ kind: "newer", found: 10 });
  for (const found of ["", "abc", undefined]) {
    expect(checkFormat(found, 10)).toEqual({ kind: "missing" });
  }
});

test("only plain digits are a format", () => {
  for (const found of [" 1 ", "1.0", "0x1", "", "-1", "1e0"]) {
    expect(checkFormat(found, 1)).toEqual({ kind: "missing" });
    expect(checkFormat(found, 0)).toEqual({ kind: "missing" });
  }
});

test("an empty format reads as no format", () => {
  setFormat("");
  const error = refusal();
  expect(error).toBeInstanceOf(StaleIndexError);
  expect((error as Error).message).toContain("records no format");
});

function failingDb(metaError: Error, masterRow: () => unknown): Database {
  return {
    prepare: (sql: string) => ({
      get: () => {
        if (sql.includes("sqlite_master")) return masterRow();
        throw metaError;
      },
      all: () => [],
      run: () => ({ changes: 0, lastInsertRowid: 0 }),
    }),
    exec: () => {},
    close: () => {},
  };
}

test("a failed format query keeps its own error when meta exists", () => {
  const boom = new Error("disk I/O error");
  expect(() => requireIndexFormat(failingDb(boom, () => ({ 1: 1 })))).toThrow(boom);
});

test("a failed format query keeps its own error when the table lookup fails too", () => {
  const boom = new Error("disk I/O error");
  const db = failingDb(boom, () => {
    throw new Error("second failure");
  });
  expect(() => requireIndexFormat(db)).toThrow(boom);
});
