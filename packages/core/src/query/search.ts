import type { Database } from "../index-db/db.ts";
import { identifiersIn } from "../identifiers.ts";
import { requireTable } from "./tables.ts";

export interface SearchOptions {
  /** Words that must all match; a double-quoted run is a phrase, a trailing `*` a prefix. Under `syntax: "fts5"`, an FTS5 query. */
  query: string;
  /**
   * `plain` (default) searches NOT, OR and AND as words; `fts5` applies operators and throws on bad syntax.
   * `fts5` also skips identifier matching: `stale_served` there is the phrase `stale served`, stemmed.
   */
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
  const terms = options.syntax === "fts5" ? null : plainTerms(options.query);
  const match = terms ? terms.map(quoted).join(" ") : options.query;
  if (match === "") return [];

  const filters = ["pages_fts MATCH ?"];
  const params: (string | number)[] = [match];

  // pages_fts reads `stale_served` as `stale served` stemmed, so an identifier must also match whole.
  const identifiers = terms ? identifierMatch(terms) : "";
  if (identifiers !== "") {
    requireTable(db, "pages_identifiers");
    // The `+` keeps the IN off pages_fts' index: there FTS5 re-ran the MATCH per rowid, 30-100x slower.
    filters.push(
      "+pages_fts.rowid IN (SELECT rowid FROM pages_identifiers WHERE pages_identifiers MATCH ?)",
    );
    params.push(identifiers);
  }

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

interface Term {
  text: string;
  prefix: boolean;
}

const quoted = ({ text, prefix }: Term) => `"${text}"${prefix ? "*" : ""}`;

// Bare, `NULLS NOT DISTINCT` is `nulls AND NOT distinct`: the inverse, silently. Quoted, it has no operators.
function plainTerms(query: string): Term[] {
  // FTS5 ends a string at NUL and then throws "unterminated string".
  return [...query.replaceAll("\0", " ").matchAll(/"([^"]*)"|[^\s"]+|"/g)].flatMap(
    ([whole, phrase]): Term[] => {
      if (phrase !== undefined) return [{ text: phrase, prefix: false }];
      if (whole === '"') return [];
      // `"word"*` keeps prefix search without letting any operator through.
      const stem = whole.replace(/\*+$/, "");
      if (stem === whole) return [{ text: whole, prefix: false }];
      return stem === "" ? [] : [{ text: stem, prefix: true }];
    },
  );
}

/** Every identifier in the terms, whole; a term's trailing `*` carries to an identifier that ends it. */
function identifierMatch(terms: Term[]): string {
  return terms
    .flatMap(({ text, prefix }) => {
      const found = identifiersIn(text);
      return found.map((id, i) => ({
        text: id,
        // identifiersIn unescapes `\_`, so compare against unescaped text.
        prefix: prefix && i === found.length - 1 && text.replaceAll("\\_", "_").endsWith(id),
      }));
    })
    .map(quoted)
    .join(" ");
}
