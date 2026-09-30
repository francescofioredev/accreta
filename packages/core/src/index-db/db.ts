import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync, readFileSync } from "node:fs";
import { UNSUPPORTED_RUNTIME } from "../runtime.ts";

const SCHEMA_PATH = join(dirname(fileURLToPath(import.meta.url)), "schema.sql");

type Params = SQLInputValue[] | [Record<string, SQLInputValue>, ...SQLInputValue[]];

/** What accreta uses of a node:sqlite statement; rows are unknown until a caller names them. */
export interface Statement {
  all(...params: Params): unknown[];
  get(...params: Params): unknown;
  run(...params: Params): { changes: number | bigint; lastInsertRowid: number | bigint };
}

/** What accreta uses of node:sqlite's DatabaseSync. */
export interface Database {
  prepare(sql: string): Statement;
  exec(sql: string): void;
  close(): void;
}

export interface OpenOptions {
  readonly?: boolean;
}

/** SQLite without FTS5 can open an index and never search it. */
export class UnsupportedRuntimeError extends Error {
  constructor() {
    super(UNSUPPORTED_RUNTIME);
    this.name = "UnsupportedRuntimeError";
  }
}

function hasFts5(db: Database): boolean {
  try {
    db.prepare("SELECT fts5(NULL)").get();
    return true;
  } catch {
    return false;
  }
}

/** The message a runtime without FTS5 gets, or null when this one has it. */
export function sqliteSupport(): string | null {
  const db = new DatabaseSync(":memory:");
  try {
    return hasFts5(db) ? null : UNSUPPORTED_RUNTIME;
  } finally {
    db.close();
  }
}

/**
 * Open a connection to an index file, creating the schema if it is a writer.
 */
export function openIndex(path: string, opts: OpenOptions = {}): Database {
  if (!opts.readonly) mkdirSync(dirname(path), { recursive: true });

  // node:sqlite silently ignores Bun's old spelling, `readonly`, and leaves the reader writable.
  const db = new DatabaseSync(path, { readOnly: opts.readonly === true });
  if (!hasFts5(db)) {
    db.close();
    throw new UnsupportedRuntimeError();
  }

  // Only writers set WAL. A read-only connection cannot create the `-shm` file a
  // WAL database needs, so asking for WAL here is what turns a perfectly good
  // index into "unable to open database file".
  if (!opts.readonly) {
    db.exec("PRAGMA journal_mode = WAL");
    db.exec(readFileSync(SCHEMA_PATH, "utf-8"));
  }

  db.exec("PRAGMA foreign_keys = ON");
  return db;
}

/**
 * Fold the WAL back into the main file and leave the database in
 * rollback-journal mode, so it closes with no `-wal`/`-shm` beside it.
 *
 * Two reasons. The WAL is never checkpointed otherwise and grows unbounded — it
 * reached 108MB against a 12MB database in the system this was extracted from.
 * And a served index is only ever read: leaving it in WAL mode means every
 * reader needs a `-shm` it is not allowed to create.
 */
export function sealForReading(db: Database): void {
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  db.exec("PRAGMA journal_mode = DELETE");
}
