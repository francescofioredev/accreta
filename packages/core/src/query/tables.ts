import type { Database } from "../index-db/db.ts";

/** The index was built by another accreta than this one; it is never migrated, only rebuilt. */
export class StaleIndexError extends Error {
  constructor(reason: string, remedy = "run `accreta reindex`") {
    super(`${reason}; ${remedy}.`);
    this.name = "StaleIndexError";
  }
}

// Per connection: a rebuild replaces the file, and a reader has to reopen to see it anyway.
const present = new WeakMap<Database, Set<string>>();

/** Throw StaleIndexError rather than SQLite's bare "no such table". */
export function requireTable(db: Database, table: string): void {
  const known = present.get(db) ?? new Set<string>();
  if (known.has(table)) return;
  const row = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table);
  if (!row) throw new StaleIndexError(`This index predates the ${table} table`);
  known.add(table);
  present.set(db, known);
}
