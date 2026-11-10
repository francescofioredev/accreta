import { readFootnotes, footnoteKey } from "../citations.ts";
import type { Database } from "../index-db/db.ts";
import { JudgeUnavailableError, type Judge } from "../judge.ts";
import { UNPINNED_REVISION, type SourceAdapter } from "../source/adapter.ts";
import type { LintFinding } from "./lint.ts";

export interface SupportOptions {
  judge: Judge;
  /** p(supports) below this is reported; at or above it passes. */
  threshold: number;
}

export interface SupportReport {
  findings: LintFinding[];
  /** Citations a judge gave a verdict on. */
  judged: number;
  /** Citations whose text could not be read, or that the judge could not be asked about. */
  unjudged: number;
  /** Set once the judge became unavailable; the rest of the pass was not judged. */
  unavailable?: string;
}

interface Row {
  page_path: string;
  footnote: string;
  line: number;
  source: string;
  revision: string;
  path: string;
  locator: string;
}

// A judge sees the cited lines and nothing else (ADR-0014); a larger range is not one claim's evidence.
const MAX_EXCERPT_CHARS = 8000;

/**
 * Bands 1 and 2 of the cascade: ask the judge whether each footnote's cited lines support the
 * sentence that cites it. Advisory only: nothing here edits a page or touches a revision.
 */
export async function judgeCitations(
  db: Database,
  sources: Map<string, SourceAdapter>,
  options: SupportOptions,
  skip?: (row: { pagePath: string; footnote: string }) => boolean,
): Promise<SupportReport> {
  const rows = db
    .prepare(
      `SELECT page_path, footnote, line, source, revision, path, locator FROM citations
       WHERE source IS NOT NULL AND path IS NOT NULL AND locator IS NOT NULL AND revision IS NOT NULL
         AND revision != '' AND revision != ?
       ORDER BY page_path, line`,
    )
    .all(UNPINNED_REVISION) as Row[];
  const bodies = new Map<string, Map<string, string>>();
  const claimOf = (pagePath: string, footnote: string): string | undefined => {
    let claims = bodies.get(pagePath);
    if (!claims) {
      const page = db.prepare("SELECT body FROM pages WHERE path = ?").get(pagePath) as
        { body: string } | undefined;
      claims = new Map(
        readFootnotes(page?.body ?? "").footnotes.map((f) => [footnoteKey(f.id), f.claim]),
      );
      bodies.set(pagePath, claims);
    }
    return claims.get(footnoteKey(footnote));
  };

  const excerpts = new Map<string, Promise<string | null>>();
  const verdicts = new Map<string, ReturnType<Judge["supports"]>>();
  const findings: LintFinding[] = [];
  const seen = new Set<string>();
  let judged = 0;
  let unjudged = 0;
  let unavailable: string | undefined;

  for (const row of rows) {
    const id = `${row.page_path}\0${footnoteKey(row.footnote)}`;
    if (seen.has(id)) continue; // a duplicate definition is lint's finding, not a second judgement
    seen.add(id);
    if (skip?.({ pagePath: row.page_path, footnote: row.footnote })) continue;
    const adapter = sources.get(row.source);
    const claim = claimOf(row.page_path, row.footnote)?.trim();
    if (unavailable || !adapter?.excerpt || !claim) {
      unjudged++;
      continue;
    }
    const key = `${row.source}\0${row.path}\0${row.locator}\0${row.revision}`;
    let excerpt = excerpts.get(key);
    if (excerpt === undefined) {
      excerpt = adapter
        .excerpt(row.path, row.locator, row.revision)
        .then((r) => (r.status === "text" && r.text.length <= MAX_EXCERPT_CHARS ? r.text : null))
        .catch(() => null);
      excerpts.set(key, excerpt);
    }
    const text = await excerpt;
    if (text === null || text.trim() === "") {
      unjudged++;
      continue;
    }
    const pair = `${claim}\0${text}`;
    let pending = verdicts.get(pair);
    if (pending === undefined) {
      pending = options.judge.supports(claim, text);
      verdicts.set(pair, pending);
    }
    try {
      const result = await pending;
      judged++;
      const p = result.probabilities.supports;
      if (p < options.threshold) {
        findings.push({
          kind: "citation-unconfirmed",
          path: row.page_path,
          detail: `[^${row.footnote}] (line ${row.line}): judge ${result.judge} (${result.model}) put p(supports) at ${p.toFixed(2)}, below ${options.threshold}; re-read ${row.path}#${row.locator} at ${row.revision}`,
        });
      }
    } catch (error) {
      if (!(error instanceof JudgeUnavailableError)) throw error;
      unavailable = error.message;
      unjudged++;
    }
  }
  return { findings, judged, unjudged, unavailable };
}
