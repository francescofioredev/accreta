import type { AccretaConfig } from "../config.ts";
import type { Database } from "../index-db/db.ts";
import { tryResolveWikilink } from "../links.ts";

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
 */
export function findRelated(
  db: Database,
  pathOrTarget: string,
  config: AccretaConfig,
  options: { kinds?: readonly string[]; includeInline?: boolean } = {},
): { target: string; targetExists: boolean; relations: Relation[] } {
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
  const inbound = db
    .query(
      `SELECT l.src_path AS path, l.kind AS kind, p.type AS type, p.title AS title
       FROM links l LEFT JOIN pages p ON p.path = l.src_path
       WHERE ${inboundWhere.sql}
       ORDER BY l.kind, l.src_path`,
    )
    .all(...inboundWhere.params) as Omit<Relation, "direction">[];

  const outboundWhere = conditions("l.src_path");
  const outbound = db
    .query(
      `SELECT l.dst_path AS path, l.kind AS kind, p.type AS type, p.title AS title
       FROM links l LEFT JOIN pages p ON p.path = l.dst_path
       WHERE ${outboundWhere.sql}
       ORDER BY l.kind, l.dst_path`,
    )
    .all(...outboundWhere.params) as Omit<Relation, "direction">[];

  const targetExists = Boolean(db.query("SELECT 1 FROM pages WHERE path = ?").get(target));

  return {
    target,
    targetExists,
    relations: [
      ...inbound.map((r) => ({ ...r, direction: "inbound" as const })),
      ...outbound.map((r) => ({ ...r, direction: "outbound" as const })),
    ],
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
  const needle = term.trim().toLowerCase();
  const out: CanonicalMatch[] = [];
  const seen = new Set<string>();

  const push = (row: PageRow, matchedOn: CanonicalMatch["matchedOn"]) => {
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

  const byTitle = db.query(`${SELECT} WHERE LOWER(title) = ?`).all(needle) as PageRow[];
  for (const row of byTitle) push(row, "title");

  // Aliases live in frontmatter_json rather than a column, because which fields
  // matter is configuration. The LIKE narrows the candidates; the JSON is parsed
  // to confirm, so a page merely containing the word is not a false positive.
  const candidates = db
    .query(`${SELECT} WHERE LOWER(frontmatter_json) LIKE ?`)
    .all(`%${needle}%`) as PageRow[];
  for (const row of candidates) {
    const frontmatter = JSON.parse(row.frontmatter_json) as Record<string, unknown>;
    const aliases = frontmatter.aliases;
    if (!Array.isArray(aliases)) continue;
    if (aliases.some((a) => typeof a === "string" && a.trim().toLowerCase() === needle)) {
      push(row, "alias");
    }
  }

  return out;
}
