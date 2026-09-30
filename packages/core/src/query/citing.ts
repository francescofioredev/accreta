import type { Database } from "../index-db/db.ts";
import { parseCitation } from "../source/adapter.ts";
import { requireTable } from "./tables.ts";

/**
 * How many pages cite a source by any route lint checks: `source`, a footnote, or
 * `canonical_source`. What went unchecked when that source did not load.
 */
export function countPagesCiting(db: Database, sourceId: string): number {
  requireTable(db, "citations");
  const pages = new Set<string>();
  const bySource = db.query(`SELECT path FROM pages WHERE source = ?`).all(sourceId);
  for (const row of bySource as { path: string }[]) pages.add(row.path);

  const byFootnote = db
    .query(`SELECT DISTINCT page_path FROM citations WHERE source = ?`)
    .all(sourceId);
  for (const row of byFootnote as { page_path: string }[]) pages.add(row.page_path);

  // Parsed as lint parses it, so both agree on what "cites" means.
  const canonical = db
    .query(
      `SELECT path, canonical_source FROM pages
       WHERE canonical_source IS NOT NULL AND canonical_source != ''`,
    )
    .all() as { path: string; canonical_source: string }[];
  for (const row of canonical) {
    if (parseCitation(row.canonical_source)?.sourceId === sourceId) pages.add(row.path);
  }
  return pages.size;
}
