import type { Database } from "../index-db/db.ts";
import { UnknownRevisionError, type SourceAdapter } from "./adapter.ts";

export interface DriftReport {
  sourceId: string;
  /** The revision the source is at now. */
  currentRevision: string;
  /** Pages whose recorded revision differs from the source's current one. */
  stale: StalePage[];
  /**
   * Pages that record no revision at all. Not drift — something weaker and
   * worse: there is no revision to compare against, so nothing can be said
   * about whether they are current.
   */
  unverifiable: string[];
  /**
   * Revisions the source could not place, with the pages recording them.
   *
   * Distinct from "nothing changed". A page verified against a revision the
   * source cannot resolve — history rewritten, shallow clone, a different
   * repository — is in an unknown state, and reporting it as current would be
   * a claim the system cannot support.
   */
  unresolvable: UnresolvableRevision[];
}

export interface StalePage {
  path: string;
  verifiedAt: string;
  /** Source paths that changed since, when the source can say. */
  changedPaths: string[];
}

export interface UnresolvableRevision {
  revision: string;
  pages: string[];
}

interface PageRow {
  path: string;
  last_verified_revision: string | null;
}

/**
 * Report which pages a source has moved out from under.
 *
 * This function is the reason `SourceAdapter` exists. It asks only
 * `revision()` and `changedSince()`, so it works identically for a git
 * repository, a directory of documents, or anything else that can answer those
 * two questions. It never learns what kind of source it is holding — and if it
 * ever needs to, the interface is missing something.
 */
export async function detectDrift(db: Database, adapter: SourceAdapter): Promise<DriftReport> {
  const currentRevision = await adapter.revision();

  const rows = db
    .query(
      `SELECT path, last_verified_revision
       FROM pages
       WHERE source = ?
       ORDER BY path`,
    )
    .all(adapter.id) as PageRow[];

  const unverifiable: string[] = [];
  const byRevision = new Map<string, string[]>();

  for (const row of rows) {
    const revision = row.last_verified_revision;
    if (!revision) {
      unverifiable.push(row.path);
      continue;
    }
    const pages = byRevision.get(revision);
    if (pages) pages.push(row.path);
    else byRevision.set(revision, [row.path]);
  }

  const stale: StalePage[] = [];
  const unresolvable: UnresolvableRevision[] = [];

  for (const [revision, pages] of byRevision) {
    if (revision === currentRevision) continue;

    let changedPaths: string[];
    try {
      changedPaths = await adapter.changedSince(revision);
    } catch (error) {
      if (error instanceof UnknownRevisionError) {
        unresolvable.push({ revision, pages });
        continue;
      }
      throw error;
    }

    // A revision that differs but whose diff is empty is not drift: the source
    // moved in ways that did not touch it. Reporting it would train the reader
    // to ignore the report.
    if (changedPaths.length === 0) continue;

    for (const path of pages) {
      stale.push({ path, verifiedAt: revision, changedPaths });
    }
  }

  stale.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  return { sourceId: adapter.id, currentRevision, stale, unverifiable, unresolvable };
}
