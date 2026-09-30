import { accretaJson, readIndex, reindex, type FootnoteRow, type Kb } from "./accreta.ts";
import { claims } from "./claims.ts";
import { declaredSources } from "./sources.ts";
import { gate, rate, summary, type GateVerdict, type Rate, type Summary } from "./stats.ts";

export const RESOLVE_FLOOR = 0.95;

interface LintFinding {
  kind: string;
  path: string;
  detail: string;
}

export interface LintJson {
  pages_checked: number;
  count: number;
  citations_checked: number;
  citations_unchecked: number;
  unchecked_reasons: { detail: string; citations: number; paths: string[] }[];
  findings: LintFinding[];
}

export type FootnoteStatus = "resolves" | "fails" | "unchecked";

export interface FootnoteVerdict {
  page: string;
  footnote: string;
  line: number;
  status: FootnoteStatus;
  /** The lint finding kinds that failed it, or why it went unchecked. */
  why: string[];
}

export interface PageMetrics {
  pages: number;
  claims: { cited: Rate; perPage: { page: string; claims: number; cited: number }[] };
  citations: {
    /** Every footnote citation in the denominator; an unchecked one counts against it. */
    resolve: Rate;
    /** Only those a source could check. */
    resolveChecked: Rate;
    unchecked: number;
    gate: GateVerdict;
    byStatus: Record<FootnoteStatus, number>;
    footnotes: FootnoteVerdict[];
  };
  lint: {
    perPage: Summary;
    pagesClean: Rate;
    byKind: Record<string, number>;
    /** Findings about the knowledge base itself: its config, a source declaration. */
    kbLevel: number;
  };
}

const FOOTNOTE_KINDS = new Set([
  "unparseable-citation",
  "citation-path-missing",
  "citation-locator-missing",
  "citation-unpinned",
  "citation-revision-unknown",
  "duplicate-footnote",
]);

/** The finding labels lint gives a footnote (see lintCitations in core); matched, never re-derived. */
function belongsTo(finding: LintFinding, row: FootnoteRow): boolean {
  if (finding.path !== row.page_path || !FOOTNOTE_KINDS.has(finding.kind)) return false;
  const id = `[^${row.footnote}]`;
  return (
    finding.detail.startsWith(`${id} (line ${row.line}) `) ||
    finding.detail.startsWith(`${id} is defined again at line ${row.line} `)
  );
}

/** Each footnote's verdict from `accreta lint --json`, which runs #123's per-footnote checks. */
export function footnoteVerdicts(
  rows: readonly FootnoteRow[],
  lint: LintJson,
  loadedSources: ReadonlySet<string>,
): FootnoteVerdict[] {
  const unchecked = new Map<string, string>();
  for (const reason of lint.unchecked_reasons) {
    for (const path of reason.paths) unchecked.set(path, reason.detail);
  }
  return rows.map((row) => {
    const base = { page: row.page_path, footnote: row.footnote, line: row.line };
    const failed = lint.findings.filter((f) => belongsTo(f, row)).map((f) => f.kind);
    if (failed.length > 0) return { ...base, status: "fails", why: failed };
    if (row.source === null || !loadedSources.has(row.source)) {
      return { ...base, status: "unchecked", why: [`source "${row.source}" is not loaded`] };
    }
    const reason = unchecked.get(`${row.source}:${row.path}`);
    if (reason !== undefined) return { ...base, status: "unchecked", why: [reason] };
    return { ...base, status: "resolves", why: [] };
  });
}

export function measurePages(kb: Kb): PageMetrics {
  reindex(kb);
  const { pages, footnotes } = readIndex(kb);
  const lint = accretaJson<LintJson>(kb, "lint", "--json");

  const unloadedFiles = new Set(
    lint.findings.filter((f) => f.kind === "unloaded-source").map((f) => f.path),
  );
  const loaded = new Set(
    declaredSources(kb.root)
      .filter((s) => !unloadedFiles.has(s.file))
      .map((s) => s.id),
  );

  const citing = new Map<string, Set<string>>();
  for (const row of footnotes) {
    const ids = citing.get(row.page_path) ?? new Set<string>();
    ids.add(row.footnote);
    citing.set(row.page_path, ids);
  }
  // A sentence is cited when it references a footnote that is a citation attempt on its page.
  const perPage = pages.map((page) => {
    const found = claims(page.body);
    const ids = citing.get(page.path) ?? new Set<string>();
    return {
      page: page.path,
      claims: found.length,
      cited: found.filter((c) => c.footnotes.some((id) => ids.has(id))).length,
    };
  });
  const totalClaims = perPage.reduce((s, p) => s + p.claims, 0);
  const citedClaims = perPage.reduce((s, p) => s + p.cited, 0);

  const verdicts = footnoteVerdicts(footnotes, lint, loaded);
  const count = (status: FootnoteStatus) => verdicts.filter((v) => v.status === status).length;
  const byStatus = {
    resolves: count("resolves"),
    fails: count("fails"),
    unchecked: count("unchecked"),
  };
  const resolve = rate(byStatus.resolves, verdicts.length);

  const pagePaths = new Set(pages.map((p) => p.path));
  const findingsPerPage = new Map(pages.map((p) => [p.path, 0]));
  const byKind: Record<string, number> = {};
  let kbLevel = 0;
  for (const f of lint.findings) {
    byKind[f.kind] = (byKind[f.kind] ?? 0) + 1;
    if (pagePaths.has(f.path)) findingsPerPage.set(f.path, findingsPerPage.get(f.path)! + 1);
    else kbLevel++;
  }
  const counts = [...findingsPerPage.values()];

  return {
    pages: pages.length,
    claims: { cited: rate(citedClaims, totalClaims), perPage },
    citations: {
      resolve,
      resolveChecked: rate(byStatus.resolves, byStatus.resolves + byStatus.fails),
      unchecked: byStatus.unchecked,
      gate: gate(resolve, RESOLVE_FLOOR),
      byStatus,
      footnotes: verdicts,
    },
    lint: {
      perPage: summary(counts),
      pagesClean: rate(counts.filter((n) => n === 0).length, counts.length),
      byKind,
      kbLevel,
    },
  };
}
