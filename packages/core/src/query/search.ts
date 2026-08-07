import type { Database } from "../index-db/db.ts";

export interface SearchOptions {
  /** FTS5 query. Supports phrases, AND/OR/NOT. */
  query: string;
  /** Restrict to these page types. Empty means every type. */
  types?: readonly string[];
  /** Restrict to one source. */
  source?: string;
  limit?: number;
}

export interface SearchHit {
  path: string;
  type: string;
  title: string;
  source: string | null;
  snippet: string;
  lastVerifiedRevision: string | null;
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

/**
 * Full-text search over titles and bodies.
 *
 * Page types are not validated against the configured vocabulary here. A filter
 * naming a type no page uses returns nothing, which is the same answer
 * validation would give, and leaves the core free of any list of what types
 * exist.
 */
export function searchPages(db: Database, options: SearchOptions): SearchHit[] {
  const limit = Math.min(Math.max(options.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);

  const filters = ["pages_fts MATCH ?"];
  const params: (string | number)[] = [options.query];

  if (options.types && options.types.length > 0) {
    filters.push(`p.type IN (${options.types.map(() => "?").join(",")})`);
    params.push(...options.types);
  }
  if (options.source) {
    filters.push("p.source = ?");
    params.push(options.source);
  }

  const rows = db
    .query(
      `SELECT
         p.path AS path,
         p.type AS type,
         p.title AS title,
         p.source AS source,
         snippet(pages_fts, 1, '<<', '>>', ' … ', 16) AS snippet,
         p.last_verified_revision AS lastVerifiedRevision
       FROM pages_fts
       JOIN pages p ON p.path = pages_fts.path
       WHERE ${filters.join(" AND ")}
       ORDER BY rank
       LIMIT ?`,
    )
    .all(...params, limit) as SearchHit[];

  return rows;
}
