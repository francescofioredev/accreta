import type { Database } from "../index-db/db.ts";
import { compileCitationTemplate } from "../citations.ts";
import type { AccretaConfig } from "../config.ts";
import {
  formatCanonicalSource,
  parseCitation,
  UNPINNED_REVISION,
  unknownVerdict,
  type LocationVerdict,
  type SourceAdapter,
} from "../source/adapter.ts";
import { paginate, type PageInfo, type PageRequest } from "./paging.ts";
import { supersessionFindings } from "./supersession.ts";

export const LINT_FINDING_KINDS = [
  "broken-link",
  "unknown-page-type",
  "missing-provenance",
  "unverified-page",
  "dangling-link",
  "unparseable-frontmatter",
  "unparseable-citation",
  "citation-path-missing",
  "citation-locator-missing",
  "citation-unpinned",
  "citation-revision-unknown",
  "duplicate-footnote",
  "unreadable-provenance-format",
  "unloaded-source",
  "inconsistent-supersession",
] as const;

export type LintFindingKind = (typeof LINT_FINDING_KINDS)[number];

export interface LintFinding {
  kind: LintFindingKind;
  path: string;
  detail: string;
}

export interface LintReport {
  findings: LintFinding[];
  pagesChecked: number;
  /** Citations a source answered for, `canonical_source` and footnotes alike. */
  citationsChecked: number;
  /**
   * Citations whose source could not check them.
   *
   * A count rather than findings, because a source accreta reaches only through
   * the agent answers "unknown" for every citation into it, and reporting that
   * as a finding per page would dress "I did not look" up as "I found
   * something". The number is still worth showing: it is the size of what this
   * pass did not cover.
   */
  citationsUnchecked: number;
  /** Why they went unchecked, by the source's own detail, with the `source:path` values it covers. */
  uncheckedReasons: { detail: string; citations: number; paths: string[] }[];
}

interface BrokenRow {
  src_path: string;
  target: string;
  kind: string;
  reason: string;
}

interface PageRow {
  path: string;
  type: string;
  canonical_source: string | null;
  last_verified_revision: string | null;
  frontmatter_error: string | null;
}

/**
 * Report what is wrong with a knowledge base.
 *
 * The failure this exists to prevent is the one that recurred throughout phase
 * 1: a link that does not resolve looks exactly like a page with fewer
 * relations. Nothing about a knowledge base's appearance reveals it — the pages
 * render, the links are blue on GitHub, and impact analysis quietly returns a
 * short answer. Lint is where that becomes visible.
 */
export function lint(db: Database, config: AccretaConfig): LintReport {
  const findings: LintFinding[] = [];

  // Links the indexer could not resolve to a path inside the knowledge base.
  const broken = db
    .query(
      `SELECT src_path, target, kind, reason FROM broken_links ORDER BY src_path, target, kind`,
    )
    .all() as BrokenRow[];
  for (const row of broken) {
    findings.push({
      kind: "broken-link",
      path: row.src_path,
      detail: `[[${row.target}]] (${row.kind}) does not resolve: ${row.reason}`,
    });
  }

  // Links that resolve to a well-formed path where no page exists. Distinct
  // from a broken link: the target is sayable, it just is not there — usually a
  // page that was renamed or has not been written yet.
  const dangling = db
    .query(
      `SELECT l.src_path AS src_path, l.dst_path AS target, l.kind AS kind
       FROM links l
       LEFT JOIN pages p ON p.path = l.dst_path
       WHERE p.path IS NULL
       ORDER BY l.src_path, l.dst_path, l.kind`,
    )
    .all() as { src_path: string; target: string; kind: string }[];
  for (const row of dangling) {
    findings.push({
      kind: "dangling-link",
      path: row.src_path,
      detail: `${row.target} (${row.kind}) is linked but no such page exists`,
    });
  }

  const pages = db
    .query(
      `SELECT path, type, canonical_source, last_verified_revision, frontmatter_error
       FROM pages ORDER BY path`,
    )
    .all() as PageRow[];

  // Reported once, against the config: every footnote in the knowledge base goes unchecked.
  const format = compileCitationTemplate(config.provenanceFormat);
  if (!format.ok) {
    findings.push({
      kind: "unreadable-provenance-format",
      path: "accreta.config.yaml",
      detail: `${format.reason}; footnote citations are not checked`,
    });
  }

  const knownTypes = new Set(config.pageTypes);
  for (const page of pages) {
    // Reported first, and *alongside* the three below rather than instead of
    // them. A page whose frontmatter would not load really does lack a type and
    // provenance, so suppressing those would hide real gaps if this diagnosis
    // were ever wrong. What was missing was the cause: an author told only that
    // `canonical_source` is absent goes and adds a field that is already there,
    // three lines above the one that actually broke.
    if (page.frontmatter_error) {
      findings.push({
        kind: "unparseable-frontmatter",
        path: page.path,
        detail: `frontmatter was discarded and every field with it — ${page.frontmatter_error}`,
      });
    }

    if (!knownTypes.has(page.type)) {
      findings.push({
        kind: "unknown-page-type",
        path: page.path,
        detail: `type "${page.type}" is not in page_types (${config.pageTypes.join(", ")})`,
      });
    }

    // A page without a canonical source cannot answer "what is the authoritative
    // definition of this", and one without a verified revision cannot drift —
    // not because it is current, but because nothing knows what it was checked
    // against. Both render fine and are nearly useless.
    if (!page.canonical_source) {
      findings.push({
        kind: "missing-provenance",
        path: page.path,
        detail: "no canonical_source: this page cites nothing",
      });
    }
    if (!page.last_verified_revision) {
      findings.push({
        kind: "unverified-page",
        path: page.path,
        detail: "no last_verified_revision: drift cannot be detected for this page",
      });
    }
  }

  findings.push(...supersessionFindings(db, config));

  return {
    findings,
    pagesChecked: pages.length,
    citationsChecked: 0,
    citationsUnchecked: 0,
    uncheckedReasons: [],
  };
}

interface CitationRow {
  path: string;
  canonical_source: string;
}

interface FootnoteRow {
  page_path: string;
  footnote: string;
  line: number;
  text: string;
  source: string | null;
  revision: string | null;
  path: string | null;
  locator: string | null;
}

/**
 * Check that citations point at things that exist.
 *
 * Provenance is the first property this project claims, and until now the only
 * thing verified about `canonical_source` was that it was non-null. A pointer
 * naming a file that was never there, or a line range past the end of one,
 * passed every check the project had and was then served by `find_canonical` as
 * the authoritative answer.
 *
 * The check is `SourceAdapter.locate`, and the adapter decides what a locator
 * means — so the core still cannot tell one adapter from another, and no longer
 * has to believe that addressing a document means counting its newlines.
 *
 * Separate from `lint` rather than folded into it because this one does I/O:
 * `lint` reads the index and answers synchronously, and every caller of it
 * depends on that. `detectDrift` is the same shape for the same reason.
 *
 * What this cannot do is judge whether a range that exists actually supports
 * the claim. That needs reading both, and it is not attempted here.
 */
export async function lintCitations(
  db: Database,
  sources: Map<string, SourceAdapter>,
): Promise<LintReport> {
  const findings: LintFinding[] = [];
  const unchecked = new Map<string, { citations: number; paths: Set<string> }>();
  const skip = (detail: string, sourceId: string, path: string) => {
    const group = unchecked.get(detail) ?? { citations: 0, paths: new Set<string>() };
    group.citations++;
    group.paths.add(formatCanonicalSource({ sourceId, path }));
    unchecked.set(detail, group);
  };

  const pages = db
    .query(
      `SELECT path, canonical_source FROM pages
       WHERE canonical_source IS NOT NULL AND canonical_source != ''
       ORDER BY path`,
    )
    .all() as CitationRow[];

  // One question per distinct location, not per citation: a knowledge base
  // cites the same place from many pages.
  const verdicts = new Map<string, Promise<LocationVerdict>>();
  const locate = (adapter: SourceAdapter, path: string, locator?: string) => {
    const key = `${adapter.id}\0${path}\0${locator ?? ""}`;
    let verdict = verdicts.get(key);
    if (verdict === undefined) {
      verdict = adapter.locate(path, locator).catch((error) => unknownVerdict(error));
      verdicts.set(key, verdict);
    }
    return verdict;
  };

  const footnotes = db
    .query(
      `SELECT page_path, footnote, line, text, source, revision, path, locator
       FROM citations ORDER BY page_path, line`,
    )
    .all() as FootnoteRow[];

  // Asked all at once, so an adapter can answer a pass in one batch rather than one per location.
  for (const page of pages) {
    const citation = parseCitation(page.canonical_source);
    const adapter = citation && sources.get(citation.sourceId);
    if (citation && adapter) void locate(adapter, citation.path, citation.locator);
  }
  for (const row of footnotes) {
    const adapter = row.source === null ? undefined : sources.get(row.source);
    if (adapter && row.path !== null) void locate(adapter, row.path, row.locator ?? undefined);
  }

  let citationsChecked = 0;
  const checkedPages = new Set<string>();

  for (const page of pages) {
    checkedPages.add(page.path);
    const citation = parseCitation(page.canonical_source);
    if (!citation) {
      findings.push({
        kind: "unparseable-citation",
        path: page.path,
        detail: `canonical_source "${page.canonical_source}" is not source:path#locator`,
      });
      continue;
    }

    const adapter = sources.get(citation.sourceId);
    // A source that is not configured cannot be checked, and saying so as a
    // finding would dress "I did not look" up as "I found something". Working
    // against a subset of the declared sources is a normal thing to do.
    if (!adapter) continue;

    const verdict = await locate(adapter, citation.path, citation.locator);
    if (verdict.verdict === "unknown") {
      skip(verdict.detail, citation.sourceId, citation.path);
      continue;
    }
    citationsChecked++;
    if (verdict.verdict === "missing") {
      findings.push({
        kind: verdict.part === "path" ? "citation-path-missing" : "citation-locator-missing",
        path: page.path,
        detail: verdict.detail,
      });
    }
  }

  // One question per revision, for the same reason as per location.
  const revisions = new Map<string, Promise<boolean | null>>();
  const knows = (adapter: SourceAdapter, revision: string) => {
    const key = `${adapter.id}\0${revision}`;
    let known = revisions.get(key);
    if (known === undefined) {
      known = adapter.knowsRevision
        ? adapter.knowsRevision(revision).catch(() => null)
        : Promise.resolve(null);
      revisions.set(key, known);
    }
    return known;
  };

  const firstLine = new Map<string, number>();
  for (const row of footnotes) {
    checkedPages.add(row.page_path);
    const id = `${row.page_path}\0${row.footnote}`;
    const first = firstLine.get(id);
    if (first !== undefined) {
      findings.push({
        kind: "duplicate-footnote",
        path: row.page_path,
        detail: `[^${row.footnote}] is defined again at line ${row.line} (first at line ${first}); a renderer shows only the first`,
      });
      continue;
    }
    firstLine.set(id, row.line);
    const label = `[^${row.footnote}] (line ${row.line})`;
    if (row.source === null || row.path === null) {
      findings.push({
        kind: "unparseable-citation",
        path: row.page_path,
        detail: `${label} "${row.text}" does not read as the configured provenance.format`,
      });
      continue;
    }
    if (row.revision !== null && (row.revision === "" || row.revision === UNPINNED_REVISION)) {
      findings.push({
        kind: "citation-unpinned",
        path: row.page_path,
        detail: `${label} names no revision, so drift cannot be detected for it`,
      });
    }

    const adapter = sources.get(row.source);
    if (!adapter) continue;

    const verdict = await locate(adapter, row.path, row.locator ?? undefined);
    if (verdict.verdict === "unknown") {
      skip(verdict.detail, row.source, row.path);
      continue;
    }
    citationsChecked++;
    if (verdict.verdict === "missing") {
      findings.push({
        kind: verdict.part === "path" ? "citation-path-missing" : "citation-locator-missing",
        path: row.page_path,
        detail: `${label} ${verdict.detail}`,
      });
    }

    if (row.revision && row.revision !== UNPINNED_REVISION) {
      if ((await knows(adapter, row.revision)) === false) {
        findings.push({
          kind: "citation-revision-unknown",
          path: row.page_path,
          detail: `${label} cites revision ${row.revision}, which source "${adapter.id}" does not have`,
        });
      }
    }
  }

  const uncheckedReasons = [...unchecked]
    .map(([detail, { citations, paths }]) => ({ detail, citations, paths: [...paths].toSorted() }))
    .toSorted((a, b) => b.citations - a.citations || a.detail.localeCompare(b.detail));
  return {
    findings,
    pagesChecked: checkedPages.size,
    citationsChecked,
    citationsUnchecked: uncheckedReasons.reduce((sum, r) => sum + r.citations, 0),
    uncheckedReasons,
  };
}

/**
 * `lint`, then `sourceFindings`, then `lintCitations`, filtered to `kinds` and paged together.
 * The citation counts and reasons stay whole-pass values either way.
 */
export async function lintKnowledgeBase(
  db: Database,
  config: AccretaConfig,
  sources: Map<string, SourceAdapter>,
  options: {
    page?: PageRequest;
    kinds?: readonly LintFindingKind[];
    /** Findings about the sources themselves, such as one that did not load; only the caller knows them. */
    sourceFindings?: readonly LintFinding[];
  } = {},
): Promise<LintReport & PageInfo> {
  const report = lint(db, config);
  const citations = await lintCitations(db, sources);
  const kinds = options.kinds && options.kinds.length > 0 ? new Set(options.kinds) : null;
  const findings = [
    ...report.findings,
    ...(options.sourceFindings ?? []),
    ...citations.findings,
  ].filter((finding) => !kinds || kinds.has(finding.kind));
  const scope = `lint\0${kinds ? [...kinds].toSorted().join(",") : ""}`;
  const { items, total, nextCursor } = options.page
    ? paginate(findings, options.page, scope)
    : { items: findings, total: findings.length, nextCursor: undefined };
  return {
    findings: items,
    total,
    nextCursor,
    pagesChecked: report.pagesChecked,
    citationsChecked: citations.citationsChecked,
    citationsUnchecked: citations.citationsUnchecked,
    uncheckedReasons: citations.uncheckedReasons,
  };
}
