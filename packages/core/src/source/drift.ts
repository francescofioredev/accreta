import type { Database } from "../index-db/db.ts";
import { requireTable } from "../query/tables.ts";
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
  /** Why each page of another source is in `unverifiable`: its citations here name no revision. */
  unpinned?: UnpinnedCitation[];
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

/** A citation from another source's page with no revision of this source to read its lines at. */
export interface UnpinnedCitation {
  page: string;
  /** The footnote id, or null for the page's `canonical_source`. */
  footnote: string | null;
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
  /** Pages recording this revision, or citing this source at it, sorted by path. */
  pages: string[];
  /** Those of `pages` here only because a citation is pinned at this revision: not verified at it. */
  citedOnly?: string[];
  /**
   * Citations from these pages into paths changed since their revision, and what the change did
   * to each. Absent when the source cannot diff contents: every page is in doubt per file.
   */
  citations?: CitedChange[];
  /** Without `citations`: the paths among `changedPaths` each of `citedOnly` cites. */
  citedPaths?: Record<string, string[]>;
}

/** One citation into a changed path. */
export interface CitedChange {
  page: string;
  /** The footnote id, or null for the page's `canonical_source`. */
  footnote: string | null;
  path: string;
  locator: string | null;
  /** The revision the citation names, or the page's when it names none: its line numbers belong to it. */
  revision: string;
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
  /** Those of `pages` here only because a citation is pinned at this revision. */
  citedOnly?: string[];
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
    .prepare(
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

  const cited = citationsInto(db, adapter.id, rows);
  const unpinnedPages = [...new Set(cited.unpinned.map((u) => u.page))];
  if (unpinnedPages.length > 0) {
    unverifiable.push(...unpinnedPages);
    unverifiable.sort();
  }
  const unpinnedReport = cited.unpinned.length > 0 ? { unpinned: cited.unpinned } : {};
  const lent = cited.lent;
  const everyPage = (revision: string) =>
    grouped(byRevision.get(revision) ?? [], [...(lent.get(revision)?.keys() ?? [])]);

  // Asked after the pages are partitioned, so a source that declines to answer
  // still produces the list of what is waiting on it. A page recording no
  // revision is unverifiable whoever holds the source.
  let currentRevision: string;
  try {
    currentRevision = await adapter.revision();
  } catch (error) {
    if (error instanceof DelegatedSourceError) {
      const revisions = new Set([...byRevision.keys(), ...lent.keys()]);
      return {
        sourceId: adapter.id,
        currentRevision: null,
        stale: [],
        unverifiable,
        ...unpinnedReport,
        unresolvable: [],
        delegated: {
          via: error.via,
          guidance: error.guidance,
          pending: byFirstPage(
            [...revisions].map((revision) => ({ revision, ...everyPage(revision) })),
          ),
        },
      };
    }
    throw error;
  }

  // Null when the source cannot place the revision. Cached: pins repeat across pages.
  const changes = new Map<string, string[] | null>();
  const changedSince = async (revision: string): Promise<string[] | null> => {
    if (revision === currentRevision) return [];
    if (!changes.has(revision)) {
      try {
        changes.set(revision, await adapter.changedSince(revision));
      } catch (error) {
        if (!(error instanceof UnknownRevisionError)) throw error;
        changes.set(revision, null);
      }
    }
    return changes.get(revision)!;
  };

  // A footnote pinned elsewhere is checked at its pin when its page's group will not check it,
  // or when the pin cannot be placed: that is the same answer whatever else the change touched.
  for (const [revision, pages] of byRevision) {
    const since = await changedSince(revision);
    if (since === null) continue;
    for (const page of pages) {
      for (const cite of cited.own.get(page) ?? []) {
        if (unpinned(cite.revision) || cite.revision === revision) continue;
        if (since.length === 0 || (await changedSince(cite.revision!)) === null) {
          lend(lent, cite.revision!, page, cite);
        }
      }
    }
  }

  const stale: StaleRevision[] = [];
  const unresolvable: UnresolvableRevision[] = [];

  for (const revision of new Set([...byRevision.keys(), ...lent.keys()])) {
    const changedPaths = await changedSince(revision);
    if (changedPaths === null) {
      unresolvable.push({ revision, ...everyPage(revision) });
      continue;
    }

    // A revision that differs but whose diff is empty is not drift: the source
    // moved in ways that did not touch it. Reporting it would train the reader
    // to ignore the report.
    if (changedPaths.length === 0) continue;

    // A page here only through a pinned citation rests on the files it cites, not the whole source.
    const changed = new Set(changedPaths);
    const touched = [...(lent.get(revision) ?? [])]
      .filter(([, cites]) => cites.some((cite) => changed.has(cite.path)))
      .map(([page]) => page);
    const group = grouped(byRevision.get(revision) ?? [], touched);
    if (group.pages.length > 0) stale.push({ revision, changedPaths, ...group });
  }

  const touchedSince = adapter.touchedSince?.bind(adapter);
  for (const entry of stale) {
    const borrowed = lent.get(entry.revision);
    const citesOf = (page: string) => borrowed?.get(page) ?? cited.own.get(page) ?? [];
    if (touchedSince) {
      entry.citations = await citedChanges(touchedSince, entry, citesOf, changedSince);
      continue;
    }
    const changed = new Set(entry.changedPaths);
    const citedPaths: Record<string, string[]> = {};
    for (const page of entry.citedOnly ?? []) {
      const hit = [...new Set(citesOf(page).map((cite) => cite.path))].filter((path) =>
        changed.has(path),
      );
      if (hit.length > 0) citedPaths[page] = hit;
    }
    if (Object.keys(citedPaths).length > 0) entry.citedPaths = citedPaths;
  }

  return {
    sourceId: adapter.id,
    currentRevision,
    stale: byFirstPage(stale),
    unverifiable,
    ...unpinnedReport,
    unresolvable,
    delegated: null,
  };
}

/** A revision's own pages and the pages citing it, in path order. */
function grouped(own: string[], citing: string[]): { pages: string[]; citedOnly?: string[] } {
  const mine = new Set(own);
  const citedOnly = citing.filter((page) => !mine.has(page));
  if (citedOnly.length === 0) return { pages: own };
  return { pages: [...own, ...citedOnly].toSorted(), citedOnly: citedOnly.toSorted() };
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

type Lent = Map<string, Map<string, Cite[]>>;

function lend(lent: Lent, revision: string, page: string, cite: Cite): void {
  const pages = lent.get(revision) ?? new Map<string, Cite[]>();
  lent.set(revision, pages);
  const cites = pages.get(page);
  if (cites) cites.push(cite);
  else pages.set(page, [cite]);
}

const unpinned = (revision: string | null) => !revision || revision === UNPINNED_REVISION;

interface CitationsInto {
  /** Citations from this source's pages, `canonical_source` first, footnotes in page order. */
  own: Map<string, Cite[]>;
  /** Pinned citations from other sources' pages, by pin, then by page. */
  lent: Lent;
  /** Citations from other sources' pages that name no revision of this one. */
  unpinned: UnpinnedCitation[];
}

/** Every citation into this source, whichever page holds it. */
function citationsInto(db: Database, sourceId: string, ownRows: PageRow[]): CitationsInto {
  requireTable(db, "citations");
  const own = new Map<string, Cite[]>();
  const lent: Lent = new Map();
  const unpinnedCites: UnpinnedCitation[] = [];
  const addOwn = (page: string, cite: Cite) => {
    const cites = own.get(page);
    if (cites) cites.push(cite);
    else own.set(page, [cite]);
  };

  const ownPages = new Set(ownRows.map((row) => row.path));
  for (const row of ownRows) {
    const parsed = row.canonical_source ? parseCitation(row.canonical_source) : null;
    if (parsed?.sourceId !== sourceId) continue;
    addOwn(row.path, {
      footnote: null,
      revision: null,
      path: parsed.path,
      locator: parsed.locator ?? null,
    });
  }

  // SQL only narrows to values containing "id:"; parsing decides, so drift reads them as lint does.
  const canonicalRows = db
    .prepare(
      `SELECT path, canonical_source FROM pages
       WHERE (source IS NULL OR source <> $source) AND instr(canonical_source, $source || ':') > 0`,
    )
    // Named, not ?1: Node 22.16's node:sqlite refuses numbered parameters with "column index out of range".
    .all({ $source: sourceId }) as { path: string; canonical_source: string }[];
  const canonical = new Map<string, Cite>();
  for (const row of canonicalRows) {
    const parsed = parseCitation(row.canonical_source);
    if (ownPages.has(row.path) || parsed?.sourceId !== sourceId) continue;
    const locator = parsed.locator ?? null;
    canonical.set(row.path, { footnote: null, revision: null, path: parsed.path, locator });
  }

  const footnotes = db
    .prepare(
      `SELECT page_path, footnote, revision, path, locator FROM citations
       WHERE source = ? AND path IS NOT NULL ORDER BY page_path, line`,
    )
    .all(sourceId) as FootnoteRow[];
  const borrowed = new Map<string, Cite[]>();
  for (const f of footnotes) {
    const cite: Cite = {
      footnote: f.footnote,
      revision: f.revision,
      path: f.path,
      locator: f.locator,
    };
    if (ownPages.has(f.page_path)) addOwn(f.page_path, cite);
    else borrowed.set(f.page_path, [...(borrowed.get(f.page_path) ?? []), cite]);
  }

  for (const page of [...new Set([...canonical.keys(), ...borrowed.keys()])].toSorted()) {
    const notes = borrowed.get(page) ?? [];
    const canon = canonical.get(page);
    if (canon) {
      // Its grammar has no revision, so it borrows the pin of a footnote citing exactly the same lines.
      const pin = notes.find(
        (n) => n.path === canon.path && n.locator === canon.locator && !unpinned(n.revision),
      )?.revision;
      if (pin) lend(lent, pin, page, { ...canon, revision: pin });
      else unpinnedCites.push({ page, footnote: null });
    }
    for (const note of notes) {
      if (unpinned(note.revision)) unpinnedCites.push({ page, footnote: note.footnote });
      else lend(lent, note.revision!, page, note);
    }
  }
  return { own, lent, unpinned: unpinnedCites };
}

/**
 * Ask the source what the change did to each citation into a path changed since the citation's
 * revision. The diff starts there, because its line numbers belong to it; a citation of the
 * source's own page that names none falls back to the page's. One question per revision and path.
 */
async function citedChanges(
  touchedSince: NonNullable<SourceAdapter["touchedSince"]>,
  entry: StaleRevision,
  citesOf: (page: string) => Cite[],
  changedSince: (revision: string) => Promise<string[] | null>,
): Promise<CitedChange[]> {
  const cited: CitedChange[] = [];
  const asks = new Map<string, { revision: string; path: string; locators: Set<string> }>();
  const pending: { cited: CitedChange; key: string }[] = [];
  const changedFrom = new Map<string, Set<string> | null>();

  for (const page of entry.pages) {
    for (const cite of citesOf(page)) {
      const from = unpinned(cite.revision) ? entry.revision : cite.revision!;
      if (!changedFrom.has(from)) {
        const since = from === entry.revision ? entry.changedPaths : await changedSince(from);
        changedFrom.set(from, since && new Set(since));
      }
      // A pin the source cannot place is reported as unresolvable at that pin, not here.
      const since = changedFrom.get(from);
      if (!since?.has(cite.path)) continue;
      // A whole-document citation into a changed document is touched by definition.
      const change: CitedChange = {
        page,
        footnote: cite.footnote,
        path: cite.path,
        locator: cite.locator,
        revision: from,
        change: { status: "touched" },
      };
      cited.push(change);
      if (cite.locator === null) continue;

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
