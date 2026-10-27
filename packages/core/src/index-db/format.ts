import { requireTable, StaleIndexError } from "../query/tables.ts";
import type { Database } from "./db.ts";

// Bump whenever the build changes what it writes: readers refuse any other value.
export const INDEX_FORMAT = 2;

export const INDEX_FORMAT_KEY = "index_format";

export type FormatVerdict =
  { kind: "current" } | { kind: "missing" } | { kind: "older" | "newer"; found: number };

/** Compare a recorded format with the expected one; only plain digits count as a format. */
export function checkFormat(found: string | undefined, expected: number): FormatVerdict {
  if (found === undefined || !/^\d+$/.test(found)) return { kind: "missing" };
  const value = Number(found);
  if (value === expected) return { kind: "current" };
  return { kind: value < expected ? "older" : "newer", found: value };
}

/** Refuse an index whose recorded format is not the one this accreta builds. */
export function requireIndexFormat(db: Database): void {
  let row: { value: string } | undefined;
  try {
    row = db.prepare("SELECT value FROM meta WHERE key = $key").get({ $key: INDEX_FORMAT_KEY }) as
      { value: string } | undefined;
  } catch (error) {
    // One query on the happy path; only a failure pays for asking which table is missing.
    try {
      requireTable(db, "meta");
    } catch (missing) {
      if (missing instanceof StaleIndexError) throw missing;
    }
    throw error;
  }

  const verdict = checkFormat(row?.value, INDEX_FORMAT);
  switch (verdict.kind) {
    case "current":
      return;
    case "missing":
      throw new StaleIndexError("This index records no format, so it predates format stamping");
    case "older":
      throw new StaleIndexError(
        `This index has format ${verdict.found}; this accreta reads ${INDEX_FORMAT}`,
      );
    case "newer":
      // Refused, not read: an older reader cannot know what a newer build changed.
      throw new StaleIndexError(
        `This index has format ${verdict.found}, written by a newer accreta than this one (${INDEX_FORMAT})`,
        "upgrade accreta, or run `accreta reindex` to rebuild it with this version",
      );
  }
}
