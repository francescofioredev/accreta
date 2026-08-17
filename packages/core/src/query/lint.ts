import type { Database } from "../index-db/db.ts";
import type { AccretaConfig } from "../config.ts";
import { parseCitation, type SourceAdapter } from "../source/adapter.ts";

export interface LintFinding {
  kind:
    | "broken-link"
    | "unknown-page-type"
    | "missing-provenance"
    | "unverified-page"
    | "dangling-link"
    | "unparseable-frontmatter"
    | "unparseable-citation"
    | "citation-path-missing"
    | "citation-range-out-of-bounds";
  path: string;
  detail: string;
}

export interface LintReport {
  findings: LintFinding[];
  pagesChecked: number;
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
    .query(`SELECT src_path, target, kind, reason FROM broken_links ORDER BY src_path, target`)
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
       ORDER BY l.src_path, l.dst_path`,
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

  return { findings, pagesChecked: pages.length };
}

interface CitationRow {
  path: string;
  canonical_source: string;
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
 * Two checks, both deterministic and both needing only `SourceAdapter.read`,
 * which is already on the interface — so the core still cannot tell one adapter
 * from another.
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

  const pages = db
    .query(
      `SELECT path, canonical_source FROM pages
       WHERE canonical_source IS NOT NULL AND canonical_source != ''
       ORDER BY path`,
    )
    .all() as CitationRow[];

  // One read per distinct file, not per citation: a knowledge base cites the
  // same source document from many pages.
  const lineCounts = new Map<string, number | null>();

  for (const page of pages) {
    const citation = parseCitation(page.canonical_source);
    if (!citation) {
      findings.push({
        kind: "unparseable-citation",
        path: page.path,
        detail: `canonical_source "${page.canonical_source}" is not source:path#Lstart-Lend`,
      });
      continue;
    }

    const adapter = sources.get(citation.sourceId);
    // A source that is not configured cannot be checked, and saying so as a
    // finding would dress "I did not look" up as "I found something". Working
    // against a subset of the declared sources is a normal thing to do.
    if (!adapter) continue;

    const key = `${citation.sourceId}\0${citation.path}`;
    let lines = lineCounts.get(key);
    if (lines === undefined) {
      lines = await adapter
        .read(citation.path)
        .then((text) => text.split("\n").length)
        .catch(() => null);
      lineCounts.set(key, lines);
    }

    if (lines === null) {
      findings.push({
        kind: "citation-path-missing",
        path: page.path,
        detail: `${citation.path} does not exist in source "${citation.sourceId}"`,
      });
      continue;
    }

    const range = citation.lines;
    if (range && range[1] > lines) {
      findings.push({
        kind: "citation-range-out-of-bounds",
        path: page.path,
        detail: `cites L${range[0]}-L${range[1]} but ${citation.path} has ${lines} line(s)`,
      });
    }
  }

  return { findings, pagesChecked: pages.length };
}
