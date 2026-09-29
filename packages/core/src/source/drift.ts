import type { Database } from "../index-db/db.ts";
import {
  DelegatedSourceError,
  parseCitation,
  UNPINNED_REVISION,
  UnknownRevisionError,
  type LocatorChange,
  type SourceAdapter,
} from "./adapter.ts";

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
  /**
   * Citations from these pages into `changedPaths`, and what the change did to each. Absent
   * when the source cannot diff contents: then every page is in doubt per file, as before.
   */
  citations?: CitedChange[];
}

/** One citation into a changed path. */
export interface CitedChange {
  page: string;
  /** The footnote id, or null for the page's `canonical_source`. */
  footnote: string | null;
  path: string;
  locator: string | null;
  change: LocatorChange;
}

/**
 * How much doubt a page is in, from its citations. Never "verified": a page whose cited lines
 * are untouched may still rest on lines it forgot to cite, so it is reordered, not cleared.
 */
export type PageChange = "changed" | "moved" | "untouched" | "uncited";

const DOUBT: Record<PageChange, number> = { uncited: 0, untouched: 1, moved: 2, changed: 3 };

/** Each page of a stale revision with its doubt, or null when the source could not say. */
export function pageChanges(entry: StaleRevision): Map<string, PageChange> | null {
  if (!entry.citations) return null;
  const out = new Map<string, PageChange>(entry.pages.map((page) => [page, "uncited"]));
  for (const cited of entry.citations) {
    const status = cited.change.status;
    const doubt: PageChange = status === "touched" || status === "unknown" ? "changed" : status;
    if (DOUBT[doubt] > DOUBT[out.get(cited.page) ?? "uncited"]) out.set(cited.page, doubt);
  }
  return out;
}

export interface UnresolvableRevision {
  revision: string;
  pages: string[];
}

interface PageRow {
  path: string;
  last_verified_revision: string | null;
  canonical_source: string | null;
}

interface FootnoteRow {
  page_path: string;
  footnote: string;
  revision: string | null;
  path: string;
  locator: string | null;
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
      `SELECT path, last_verified_revision, canonical_source
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

  if (adapter.touchedSince && stale.length > 0) {
    const touchedSince = adapter.touchedSince.bind(adapter);
    const cites = citationsBySource(db, adapter.id, rows);
    for (const entry of stale) {
      entry.citations = await citedChanges(touchedSince, entry, cites);
    }
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

interface Cite {
  footnote: string | null;
  revision: string | null;
  path: string;
  locator: string | null;
}

/** Every citation into this source from its pages, `canonical_source` first, footnotes in page order. */
function citationsBySource(db: Database, sourceId: string, rows: PageRow[]): Map<string, Cite[]> {
  const out = new Map<string, Cite[]>();
  const add = (page: string, cite: Cite) => {
    const list = out.get(page);
    if (list) list.push(cite);
    else out.set(page, [cite]);
  };
  for (const row of rows) {
    const parsed = row.canonical_source ? parseCitation(row.canonical_source) : null;
    if (parsed?.sourceId === sourceId) {
      add(row.path, {
        footnote: null,
        revision: null,
        path: parsed.path,
        locator: parsed.locator ?? null,
      });
    }
  }
  const footnotes = db
    .query(
      `SELECT page_path, footnote, revision, path, locator FROM citations
       WHERE source = ? ORDER BY page_path, line`,
    )
    .all(sourceId) as FootnoteRow[];
  for (const f of footnotes) add(f.page_path, { ...f });
  return out;
}

/**
 * Ask the source what the change did to each citation into a changed path. The diff starts at
 * the citation's own revision, because its line numbers belong to it; a citation naming none
 * falls back to the page's. One question per revision and path, whatever the number of pages.
 */
async function citedChanges(
  touchedSince: NonNullable<SourceAdapter["touchedSince"]>,
  entry: StaleRevision,
  cites: Map<string, Cite[]>,
): Promise<CitedChange[]> {
  const changed = new Set(entry.changedPaths);
  const cited: CitedChange[] = [];
  const asks = new Map<string, { revision: string; path: string; locators: Set<string> }>();
  const pending: { cited: CitedChange; key: string }[] = [];

  for (const page of entry.pages) {
    for (const cite of cites.get(page) ?? []) {
      if (!changed.has(cite.path)) continue;
      // A whole-document citation into a changed document is touched by definition.
      const change: CitedChange = {
        page,
        footnote: cite.footnote,
        path: cite.path,
        locator: cite.locator,
        change: { status: "touched" },
      };
      cited.push(change);
      if (cite.locator === null) continue;

      const from =
        cite.revision && cite.revision !== UNPINNED_REVISION ? cite.revision : entry.revision;
      const key = `${from}\0${cite.path}`;
      const ask = asks.get(key);
      if (ask) ask.locators.add(cite.locator);
      else asks.set(key, { revision: from, path: cite.path, locators: new Set([cite.locator]) });
      pending.push({ cited: change, key });
    }
  }

  const answers = new Map<string, Map<string, LocatorChange>>();
  for (const [key, ask] of asks) {
    try {
      answers.set(key, await touchedSince(ask.revision, ask.path, [...ask.locators]));
    } catch (error) {
      // A revision the source cannot place leaves these citations unknown, not untouched.
      if (!(error instanceof UnknownRevisionError)) throw error;
    }
  }
  for (const { cited: change, key } of pending) {
    change.change = answers.get(key)?.get(change.locator!) ?? { status: "unknown" };
  }
  return cited;
}
