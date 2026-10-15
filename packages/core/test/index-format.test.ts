import { afterEach, beforeEach, expect, test } from "bun:test";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { buildIndex } from "../src/index-db/build.ts";
import { openIndex } from "../src/index-db/db.ts";
import { INDEX_FORMAT } from "../src/index-db/format.ts";
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
