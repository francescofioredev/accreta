import { requireTable, StaleIndexError } from "../query/tables.ts";
import type { Database } from "./db.ts";

// Bump whenever the build changes what it writes: readers refuse any other value.
export const INDEX_FORMAT = 1;

export const INDEX_FORMAT_KEY = "index_format";

/** Refuse an index whose recorded format is not the one this accreta builds. */
export function requireIndexFormat(db: Database): void {
  let row: { value: string } | undefined;
  try {
    row = db.prepare("SELECT value FROM meta WHERE key = $key").get({ $key: INDEX_FORMAT_KEY }) as
      { value: string } | undefined;
  } catch (error) {
    // One query on the happy path; only a failure pays for asking which table is missing.
    requireTable(db, "meta");
    throw error;
  }

  const found = row === undefined ? Number.NaN : Number(row.value);
  if (found === INDEX_FORMAT) return;
  if (!Number.isInteger(found)) {
    throw new StaleIndexError("This index records no format, so it predates format stamping");
  }
  if (found < INDEX_FORMAT) {
    throw new StaleIndexError(`This index has format ${found}; this accreta reads ${INDEX_FORMAT}`);
  }
  // Refused, not read: an older reader cannot know what a newer build changed.
  throw new StaleIndexError(
    `This index has format ${found}, written by a newer accreta than this one (${INDEX_FORMAT})`,
    "upgrade accreta, or run `accreta reindex` to rebuild it with this version",
  );
}
