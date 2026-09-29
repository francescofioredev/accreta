import { createHash } from "node:crypto";
import type { Database } from "../index-db/db.ts";

/** A bounded slice of a result set, per ADR-0007. */
export interface PageRequest {
  /** Results per response. Clamped to 1..MAX_PAGE_LIMIT; default DEFAULT_PAGE_LIMIT. */
  limit?: number;
  /** The `nextCursor` of the previous response. Omit for the first page. */
  cursor?: string;
}

export interface PageInfo {
  /** Every result the query matched, not only the ones returned. */
  total: number;
  /** Present when results remain after this page; absent on the last, as in MCP. */
  nextCursor?: string;
}

// ADR-0007's provisional default, and search_pages' ceiling, so every list tool shares one.
export const DEFAULT_PAGE_LIMIT = 50;
export const MAX_PAGE_LIMIT = 50;

/** A cursor that does not belong to this query, or to the results it now has. */
export class InvalidCursorError extends Error {
  constructor(reason: string) {
    super(`Invalid cursor: ${reason}. Repeat the call without a cursor to start over.`);
    this.name = "InvalidCursorError";
  }
}

export function clampLimit(limit: number | undefined): number {
  return Math.min(Math.max(Math.trunc(limit ?? DEFAULT_PAGE_LIMIT), 1), MAX_PAGE_LIMIT);
}

function fingerprint(scope: string): string {
  return createHash("sha256").update(scope).digest("base64url").slice(0, 16);
}

/**
 * Where a page starts. `scope` binds the cursor to one query over one state:
 * an offset replayed against changed results would silently skip or repeat some.
 */
export function cursorOffset(request: PageRequest, scope: string): number {
  if (request.cursor === undefined) return 0;
  const decoded = Buffer.from(request.cursor, "base64url").toString("utf-8");
  const match = /^(\d+):([\w-]+)$/.exec(decoded);
  if (!match) throw new InvalidCursorError("not a cursor this server issued");
  if (match[2] !== fingerprint(scope)) {
    throw new InvalidCursorError(
      "it was issued for another query, or the results changed or the index was rebuilt since",
    );
  }
  return Number(match[1]);
}

export function nextCursorAfter(
  offset: number,
  returned: number,
  total: number,
  scope: string,
): string | undefined {
  const next = offset + returned;
  if (next >= total) return undefined;
  return Buffer.from(`${next}:${fingerprint(scope)}`, "utf-8").toString("base64url");
}

/** Page an in-memory result set; hashing the items means a cursor outlives no change to them. */
export function paginate<T>(
  items: readonly T[],
  request: PageRequest,
  scope: string,
): PageInfo & { items: T[] } {
  const bound = `${scope}\0${JSON.stringify(items)}`;
  const offset = cursorOffset(request, bound);
  const page = items.slice(offset, offset + clampLimit(request.limit));
  return {
    items: page,
    total: items.length,
    nextCursor: nextCursorAfter(offset, page.length, items.length, bound),
  };
}

/**
 * Which build of the index a cursor was issued against; a rebuild invalidates it.
 * Indexes built before `build_id` existed fall back to their millisecond timestamp.
 */
export function indexIdentity(db: Database, request: PageRequest): string {
  const read = (key: string) =>
    (db.query("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | null)?.value;
  const identity = read("build_id") ?? read("last_reindex_at");
  if (identity !== undefined) return identity;
  // With nothing to bind to, a cursor could outlive a rebuild unnoticed.
  if (request.cursor !== undefined) {
    throw new InvalidCursorError("this index records no build to check it against; run a reindex");
  }
  return "";
}
