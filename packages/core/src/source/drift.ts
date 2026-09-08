import type { Database } from "../index-db/db.ts";
import { DelegatedSourceError, UnknownRevisionError, type SourceAdapter } from "./adapter.ts";

export interface DriftReport {
  sourceId: string;
  /** The revision the source is at now, or null when accreta cannot ask. */
  currentRevision: string | null;
  /** Revisions that have moved, with the pages verified against them. */
  stale: StaleRevision[];
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
  /**
   * Set when the source is one only the agent can reach, and null otherwise.
   *
   * Not an outcome so much as the absence of one: accreta has not checked these
   * pages and cannot. It is kept apart from `unresolvable` because that means
   * something specific and alarming — the recorded revision is gone, re-verify
   * from scratch — and telling someone to redo work for a reason that never
   * happened is worse than telling them nothing.
   */
  delegated: DelegatedWork | null;
}

/** What the agent needs in order to check a source accreta cannot. */
export interface DelegatedWork {
  /** The connector to use, as the declaration named it. */
  via: string;
  /** The declaration's own description of what is in scope. Prose, uninterpreted. */
  guidance: string;
  /** Pages waiting to be checked, grouped by the revision they are stuck at. */
  pending: UnresolvableRevision[];
}

/**
 * Pages that share a stale revision, with the change that stranded them.
 *
 * Grouped rather than one entry per page because `changedPaths` belongs to the
 * revision, not to any page in it. Repeating it per page made the report the
 * product of the two: a thousand pages against a hundred-file commit serialised
 * to roughly four megabytes, most of it the same paths copied a thousand times.
 * `UnresolvableRevision` was already shaped this way; now both grouped outcomes
 * read alike.
 */
export interface StaleRevision {
  revision: string;
  /** Source paths that changed since, when the source can say. */
  changedPaths: string[];
  /** Pages recording this revision, sorted by path. */
  pages: string[];
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

  // Asked after the pages are partitioned, so a source that declines to answer
  // still produces the list of what is waiting on it. A page recording no
  // revision is unverifiable whoever holds the source.
  let currentRevision: string;
  try {
    currentRevision = await adapter.revision();
  } catch (error) {
    if (error instanceof DelegatedSourceError) {
      return {
        sourceId: adapter.id,
        currentRevision: null,
        stale: [],
        unverifiable,
        unresolvable: [],
        delegated: {
          via: error.via,
          guidance: error.guidance,
          pending: byFirstPage([...byRevision].map(([revision, pages]) => ({ revision, pages }))),
        },
      };
    }
    throw error;
  }

  const stale: StaleRevision[] = [];
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

    stale.push({ revision, changedPaths, pages });
  }

  return {
    sourceId: adapter.id,
    currentRevision,
    stale: byFirstPage(stale),
    unverifiable,
    unresolvable,
    delegated: null,
  };
}

/**
 * Order groups by their first page rather than by revision.
 *
 * A revision is an opaque string, so ordering by it would shuffle the report
 * between runs for no reason a reader could follow. `pages` arrives in path
 * order from the query.
 */
function byFirstPage<T extends { pages: string[] }>(groups: T[]): T[] {
  return groups.toSorted((a, b) => {
    const left = a.pages[0] ?? "";
    const right = b.pages[0] ?? "";
    return left < right ? -1 : left > right ? 1 : 0;
  });
}
