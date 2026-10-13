import type { Database } from "../index-db/db.ts";

export interface SearchOptions {
  /** Words that must all match; a double-quoted run is a phrase. Under `syntax: "fts5"`, an FTS5 query. */
  query: string;
  /** `plain` (default) searches NOT, OR and AND as words; `fts5` applies operators and throws on bad syntax. */
  syntax?: "plain" | "fts5";
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
 * Full-text search over titles, declared aliases, and bodies. A type filter is not checked
 * against the vocabulary: an unused type returns nothing, as validation would, without a type list.
 */
export function searchPages(db: Database, options: SearchOptions): SearchHit[] {
  const limit = Math.min(Math.max(options.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
  const match = options.syntax === "fts5" ? options.query : plainMatch(options.query);
  if (match === "") return [];

  const filters = ["pages_fts MATCH ?"];
  const params: (string | number)[] = [match];

  if (options.types && options.types.length > 0) {
    filters.push(`p.type IN (${options.types.map(() => "?").join(",")})`);
    params.push(...options.types);
  }
  if (options.source) {
    filters.push("p.source = ?");
    params.push(options.source);
  }

  const rows = db
    .prepare(
      `SELECT
         p.path AS path,
         p.type AS type,
         p.title AS title,
         p.source AS source,
         snippet(pages_fts, 2, '<<', '>>', ' … ', 16) AS snippet,
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

// Bare, `NULLS NOT DISTINCT` is `nulls AND NOT distinct`: the inverse, silently. Quoted, it has no operators.
function plainMatch(query: string): string {
  const strings = [...query.matchAll(/"([^"]*)"|[^\s"]+|"/g)]
    .map(([whole, phrase]) => phrase ?? whole)
    .filter((text) => text !== '"');
  return strings.map((text) => `"${text}"`).join(" ");
}
