import type { Database } from "../index-db/db.ts";
import type { AccretaConfig } from "../config.ts";

export interface LintFinding {
  kind:
    | "broken-link"
    | "unknown-page-type"
    | "missing-provenance"
    | "unverified-page"
    | "dangling-link"
    | "unparseable-frontmatter";
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
