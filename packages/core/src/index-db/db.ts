import { Database } from "bun:sqlite";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync, readFileSync } from "node:fs";

const SCHEMA_PATH = join(dirname(fileURLToPath(import.meta.url)), "schema.sql");

export type { Database };

export interface OpenOptions {
  readonly?: boolean;
}

/**
 * Open a connection to an index file, creating the schema if it is a writer.
 */
export function openIndex(path: string, opts: OpenOptions = {}): Database {
  if (!opts.readonly) mkdirSync(dirname(path), { recursive: true });

  const db = new Database(path, opts.readonly ? { readonly: true } : { create: true });

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
