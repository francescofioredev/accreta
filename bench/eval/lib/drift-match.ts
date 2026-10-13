import type { CitationTruth, Exclusion } from "./drift-truth.ts";
import { gate, interval, type GateVerdict, type Interval } from "./stats.ts";

/** The parts of `accreta drift --json` the score reads. */
export interface DriftJson {
  sources: {
    source_id: string;
    in_doubt: {
      page: string;
      citations:
        { footnote: string | null; path: string; locator: string | null; change: string }[] | null;
      changed_paths?: string[];
    }[];
    repin: {
      page: string;
      citations: { footnote: string | null; path: string; locator: string | null }[];
    }[];
    unresolvable: { revision: string; pages: string[] }[];
  }[];
}

export type Prediction = "flagged" | "repin" | "quiet";

// Pre-registered in protocol.md.
export const RECALL_FLOOR = 0.9;
export const EXCLUSION_CEILING = 0.2;
export const MIN_POSITIVE_FILES = 20;

const key = (
  source: string,
  page: string,
  footnote: string | null,
  path: string,
  locator: string | null,
) => JSON.stringify([source, page, footnote, path, locator]);

/** What drift said about each citation it named; unnamed ones it judged quiet. */
export function predictions(json: DriftJson): Map<string, Prediction> {
  const out = new Map<string, Prediction>();
  for (const s of json.sources) {
    for (const p of s.repin) {
      for (const c of p.citations) {
        out.set(key(s.source_id, p.page, c.footnote, c.path, c.locator), "repin");
      }
    }
    for (const p of s.in_doubt) {
      for (const c of p.citations ?? []) {
        out.set(key(s.source_id, p.page, c.footnote, c.path, c.locator), "flagged");
      }
    }
  }
  return out;
}

/** Pages drift flagged whole: per file, or at a revision it could not place. */
function wholePages(json: DriftJson): Map<string, Set<string> | "all"> {
  const out = new Map<string, Set<string> | "all">();
  for (const s of json.sources) {
    for (const p of s.in_doubt) {
      if (p.citations === null) out.set(`${s.source_id}\0${p.page}`, new Set(p.changed_paths));
    }
    for (const u of s.unresolvable)
      for (const page of u.pages) out.set(`${s.source_id}\0${page}`, "all");
  }
  return out;
}

export interface Confusion {
  tp: number;
  fp: number;
  fn: number;
  tn: number;
  precision: Interval;
  recall: Interval;
  /** Recall against the #133 floor, on the two-sided 95% Clopper–Pearson lower bound. */
  gate: GateVerdict;
}

export function confusion(pairs: readonly { truth: boolean; flagged: boolean }[]): Confusion {
  const count = (t: boolean, f: boolean) =>
    pairs.filter((p) => p.truth === t && p.flagged === f).length;
  const [tp, fp, fn, tn] = [
    count(true, true),
    count(false, true),
    count(true, false),
    count(false, false),
  ];
  const recall = interval(tp, tp + fn);
  return {
    tp,
    fp,
    fn,
    tn,
    precision: interval(tp, tp + fp),
    recall,
    gate: gate({ k: tp, n: tp + fn, rate: recall.rate, ci: recall.clopperPearson }, RECALL_FLOOR),
  };
}

export interface ScoredCitation extends CitationTruth {
  prediction: Prediction;
}

export interface DriftScore {
  /** H2 after the pre-registered conditions on the per-citation gate. */
  h2: { verdict: GateVerdict; reasons: string[] };
  /** The gate's unit (maintainer decision on #136, 2026-10-13). */
  perCitation: Confusion;
  /** Secondary: a page is positive when any of its scored citations is. */
  perPageAnyHit: Confusion;
  /** Secondary: flag every citation whose file changed at all. */
  baselineFileChanged: Confusion;
  /** Recall with every excluded citation counted as a miss. */
  recallExclusionsAsMisses: Interval;
  /** Footnote citations excluded, over all of them. */
  excludedShare: Interval;
  /** Distinct cited files among the positives: positives in one file are not independent. */
  positiveFiles: number;
  /** Truth said moved; did drift say re-pin rather than flag it? */
  moved: { total: number; repin: number; flagged: number; quiet: number };
  excluded: Partial<Record<Exclusion, number>>;
  /** Things drift should never do, whatever the gate says. */
  defects: string[];
  /** Single-line "moved" verdicts: one matching line is weak evidence, so each is checked by hand. */
  auditSingleLineMoved: ScoredCitation[];
  citations: ScoredCitation[];
}

export function scoreDrift(truth: readonly CitationTruth[], json: DriftJson): DriftScore {
  const said = predictions(json);
  const whole = wholePages(json);
  const excluded: Partial<Record<Exclusion, number>> = {};
  const citations: ScoredCitation[] = [];
  for (const t of truth) {
    if (t.excluded !== null) {
      excluded[t.excluded] = (excluded[t.excluded] ?? 0) + 1;
      continue;
    }
    const all = whole.get(`${t.source}\0${t.page}`);
    const prediction: Prediction =
      said.get(key(t.source, t.page, t.footnote, t.path, t.locator)) ??
      (all === "all" || all?.has(t.path) ? "flagged" : "quiet");
    citations.push({ ...t, prediction });
  }

  const isPositive = (c: CitationTruth) => c.status === "changed";
  const perCitation = confusion(
    citations.map((c) => ({ truth: isPositive(c), flagged: c.prediction === "flagged" })),
  );
  const pages = new Map<string, { truth: boolean; flagged: boolean }>();
  for (const c of citations) {
    const p = pages.get(c.page) ?? { truth: false, flagged: false };
    p.truth ||= isPositive(c);
    p.flagged ||= c.prediction === "flagged";
    pages.set(c.page, p);
  }

  const excludedCount = truth.length - citations.length;
  const excludedShare = interval(excludedCount, truth.length);
  const positiveFiles = new Set(
    citations.filter(isPositive).map((c) => JSON.stringify([c.source, c.path])),
  ).size;
  const reasons: string[] = [];
  if (excludedShare.rate > EXCLUSION_CEILING) {
    reasons.push(
      `${excludedCount} of ${truth.length} citations excluded, over ${EXCLUSION_CEILING}`,
    );
  }
  if (positiveFiles < MIN_POSITIVE_FILES) {
    reasons.push(`positives span ${positiveFiles} files, under ${MIN_POSITIVE_FILES}`);
  }
  const verdict = perCitation.gate === "met" && reasons.length > 0 ? "not shown" : perCitation.gate;

  const moved = citations.filter((c) => c.status === "moved");
  const by = (p: Prediction) => moved.filter((c) => c.prediction === p).length;
  const defects: string[] = [];
  if (by("quiet") > 0) {
    defects.push(`${by("quiet")} moved citation(s) neither flagged nor listed for re-pinning`);
  }
  return {
    h2: { verdict, reasons },
    perCitation,
    perPageAnyHit: confusion([...pages.values()]),
    baselineFileChanged: confusion(
      citations.map((c) => ({ truth: isPositive(c), flagged: c.fileChanged === true })),
    ),
    recallExclusionsAsMisses: interval(
      perCitation.tp,
      perCitation.tp + perCitation.fn + excludedCount,
    ),
    excludedShare,
    positiveFiles,
    moved: { total: moved.length, repin: by("repin"), flagged: by("flagged"), quiet: by("quiet") },
    excluded,
    defects,
    auditSingleLineMoved: moved.filter((c) => /^L\d+$/.test(c.now?.locator ?? "")),
    citations,
  };
}
