import type { AccretaConfig } from "../config.ts";
import type { Database } from "../index-db/db.ts";
import { tryResolveWikilink } from "../links.ts";
import { requireTable } from "./tables.ts";
import {
  clampLimit,
  cursorOffset,
  indexIdentity,
  nextCursorAfter,
  paginate,
  type PageInfo,
  type PageRequest,
} from "./paging.ts";

export interface PageRecord {
  path: string;
  type: string;
  title: string;
  source: string | null;
  canonicalSource: string | null;
  lastVerifiedRevision: string | null;
  frontmatter: Record<string, unknown>;
  body: string;
}

interface PageRow {
  path: string;
  type: string;
  title: string;
  source: string | null;
  canonical_source: string | null;
  last_verified_revision: string | null;
  frontmatter_json: string;
  body: string;
}

function toRecord(row: PageRow): PageRecord {
  return {
    path: row.path,
    type: row.type,
    title: row.title,
    source: row.source,
    canonicalSource: row.canonical_source,
    lastVerifiedRevision: row.last_verified_revision,
    frontmatter: JSON.parse(row.frontmatter_json) as Record<string, unknown>,
    body: row.body,
  };
}

const SELECT = `SELECT path, type, title, source, canonical_source,
                       last_verified_revision, frontmatter_json, body
                FROM pages`;

/**
 * Fetch a page by path or by wikilink target.
 *
 * Callers hold one or the other and should not have to know which: an agent
 * following `[[concepts/forcing]]` and a human typing a path are asking the same
 * question.
 */
export function getPage(
  db: Database,
  pathOrTarget: string,
  config: AccretaConfig,
): PageRecord | null {
  const direct = db.query(`${SELECT} WHERE path = ?`).get(pathOrTarget) as PageRow | null;
  if (direct) return toRecord(direct);

  const resolved = tryResolveWikilink(pathOrTarget, config);
  if (!resolved.ok) return null;

  const row = db.query(`${SELECT} WHERE path = ?`).get(resolved.path) as PageRow | null;
  return row ? toRecord(row) : null;
}

export interface Relation {
  path: string;
  kind: string;
  direction: "inbound" | "outbound";
  type: string | null;
  title: string | null;
}

/**
 * Pages related to a target, in both directions.
 *
 * Inbound is "who points at this"; outbound is "what this points at". Impact
 * analysis needs both, and conflating them makes "what depends on X" and "what X
 * depends on" indistinguishable in the result.
 *
 * Without `page` every relation is returned. The links key makes (kind, path) a total order.
 */
export function findRelated(
  db: Database,
  pathOrTarget: string,
  config: AccretaConfig,
  options: { kinds?: readonly string[]; includeInline?: boolean; page?: PageRequest } = {},
): { target: string; targetExists: boolean; relations: Relation[] } & PageInfo {
  const resolved = tryResolveWikilink(pathOrTarget, config);
  const target = resolved.ok ? resolved.path : pathOrTarget;

  const kindFilter = options.kinds && options.kinds.length > 0 ? options.kinds : null;
  const excludeInline = !options.includeInline && !kindFilter;

  const conditions = (column: string): { sql: string; params: string[] } => {
    const parts = [`${column} = ?`];
    const params: string[] = [target];
    if (kindFilter) {
      parts.push(`kind IN (${kindFilter.map(() => "?").join(",")})`);
      params.push(...kindFilter);
    } else if (excludeInline) {
      parts.push("kind <> 'wikilink'");
    }
    return { sql: parts.join(" AND "), params };
  };
  const inboundWhere = conditions("l.dst_path");
  const outboundWhere = conditions("l.src_path");

  const count = (where: { sql: string; params: string[] }) =>
    (
      db.query(`SELECT COUNT(*) AS n FROM links l WHERE ${where.sql}`).get(...where.params) as {
        n: number;
      }
    ).n;

  let offset = 0;
  // SQLite reads a negative LIMIT as none, which is what an unpaged call asks for.
  let limit = -1;
  let scope = "";
  let inboundTotal = Infinity;
  let total = 0;
  if (options.page) {
    inboundTotal = count(inboundWhere);
    total = inboundTotal + count(outboundWhere);
    scope = [
      "related",
      target,
      kindFilter ? kindFilter.toSorted().join(",") : "",
      String(excludeInline),
      indexIdentity(db, options.page),
    ].join("\0");
    offset = cursorOffset(options.page, scope);
    limit = clampLimit(options.page.limit);
  }

  const inboundTake = limit < 0 ? -1 : Math.max(0, Math.min(limit, inboundTotal - offset));
  const inbound =
    inboundTake === 0
      ? []
      : (db
          .query(
            `SELECT l.src_path AS path, l.kind AS kind, p.type AS type, p.title AS title
             FROM links l LEFT JOIN pages p ON p.path = l.src_path
             WHERE ${inboundWhere.sql}
             ORDER BY l.kind, l.src_path
             LIMIT ? OFFSET ?`,
          )
          .all(...inboundWhere.params, inboundTake, offset) as Omit<Relation, "direction">[]);

  const outboundTake = limit < 0 ? -1 : limit - inbound.length;
  const outbound =
    outboundTake === 0
      ? []
      : (db
          .query(
            `SELECT l.dst_path AS path, l.kind AS kind, p.type AS type, p.title AS title
             FROM links l LEFT JOIN pages p ON p.path = l.dst_path
             WHERE ${outboundWhere.sql}
             ORDER BY l.kind, l.dst_path
             LIMIT ? OFFSET ?`,
          )
          .all(...outboundWhere.params, outboundTake, Math.max(0, offset - inboundTotal)) as Omit<
          Relation,
          "direction"
        >[]);

  const targetExists = Boolean(db.query("SELECT 1 FROM pages WHERE path = ?").get(target));
  const relations = [
    ...inbound.map((r) => ({ ...r, direction: "inbound" as const })),
    ...outbound.map((r) => ({ ...r, direction: "outbound" as const })),
  ];

  if (!options.page) return { target, targetExists, relations, total: relations.length };
  return {
    target,
    targetExists,
    relations,
    total,
    nextCursor: nextCursorAfter(offset, relations.length, total, scope),
  };
}

export interface CanonicalMatch {
  path: string;
  title: string;
  type: string;
  canonicalSource: string | null;
  matchedOn: "path" | "title" | "alias";
}

/**
 * Resolve a concept to the page that authoritatively defines it.
 *
 * Aliases are consulted because the name a question arrives under is rarely the
 * name the page was filed under — "climate forcing" and "radiative forcing"
 * should reach the same place.
 */
export function findCanonical(db: Database, term: string, config: AccretaConfig): CanonicalMatch[] {
  requireTable(db, "aliases");
  const needle = term.trim().toLowerCase();
  const out: CanonicalMatch[] = [];
  const seen = new Set<string>();

  const push = (
    row: Pick<PageRow, "path" | "title" | "type" | "canonical_source">,
    matchedOn: CanonicalMatch["matchedOn"],
  ) => {
    if (seen.has(row.path)) return;
    seen.add(row.path);
    out.push({
      path: row.path,
      title: row.title,
      type: row.type,
      canonicalSource: row.canonical_source,
      matchedOn,
    });
  };

  const direct = getPage(db, term, config);
  if (direct) {
    const row = db.query(`${SELECT} WHERE path = ?`).get(direct.path) as PageRow;
    push(row, "path");
  }

  const byTitle = db
    .query(`${SELECT} WHERE LOWER(title) = ? ORDER BY path`)
    .all(needle) as PageRow[];
  for (const row of byTitle) push(row, "title");

  // Equality on whole declared aliases, so a page merely containing the words elsewhere never matches.
  const byAlias = db
    .query(
      `SELECT p.path, p.title, p.type, p.canonical_source
       FROM aliases a JOIN pages p ON p.path = a.path
       WHERE a.alias = ? ORDER BY a.path`,
    )
    .all(needle) as Pick<PageRow, "path" | "title" | "type" | "canonical_source">[];
  for (const row of byAlias) push(row, "alias");

  return out;
}

/** Paged in memory: the cursor binds to the matches, so an exact total needs them all. */
export function findCanonicalPage(
  db: Database,
  term: string,
  config: AccretaConfig,
  page: PageRequest,
): { results: CanonicalMatch[] } & PageInfo {
  const matches = findCanonical(db, term, config);
  const { items, total, nextCursor } = paginate(matches, page, `canonical\0${term}`);
  return { results: items, total, nextCursor };
}
