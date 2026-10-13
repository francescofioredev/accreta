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
    repin: { page: string; citations: { footnote: string | null; path: string }[] }[];
    unresolvable: { revision: string; pages: string[] }[];
  }[];
}

export type Prediction = "flagged" | "repin" | "quiet";

export const RECALL_FLOOR = 0.9;

const key = (source: string, page: string, footnote: string | null, path: string) =>
  JSON.stringify([source, page, footnote, path]);

/** What drift said about each citation it named; unnamed ones it judged quiet. */
export function predictions(json: DriftJson): Map<string, Prediction> {
  const out = new Map<string, Prediction>();
  for (const s of json.sources) {
    for (const p of s.repin) {
      for (const c of p.citations) out.set(key(s.source_id, p.page, c.footnote, c.path), "repin");
    }
    for (const p of s.in_doubt) {
      for (const c of p.citations ?? []) {
        out.set(key(s.source_id, p.page, c.footnote, c.path), "flagged");
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
  /** Recall against the #133 floor, on the Clopper–Pearson lower bound. */
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
  /** The gate's unit (maintainer decision on #136, 2026-10-13). */
  perCitation: Confusion;
  /** Secondary: a page is positive when any of its scored citations is. */
  perPage: Confusion;
  /** Truth said moved; did drift say re-pin rather than flag it? */
  moved: { total: number; repin: number; flagged: number; quiet: number };
  excluded: Partial<Record<Exclusion, number>>;
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
      said.get(key(t.source, t.page, t.footnote, t.path)) ??
      (all === "all" || all?.has(t.path) ? "flagged" : "quiet");
    citations.push({ ...t, prediction });
  }

  const perCitation = confusion(
    citations.map((c) => ({ truth: c.status === "changed", flagged: c.prediction === "flagged" })),
  );
  const pages = new Map<string, { truth: boolean; flagged: boolean }>();
  for (const c of citations) {
    const p = pages.get(c.page) ?? { truth: false, flagged: false };
    p.truth ||= c.status === "changed";
    p.flagged ||= c.prediction === "flagged";
    pages.set(c.page, p);
  }
  const moved = citations.filter((c) => c.status === "moved");
  const by = (p: Prediction) => moved.filter((c) => c.prediction === p).length;
  return {
    perCitation,
    perPage: confusion([...pages.values()]),
    moved: { total: moved.length, repin: by("repin"), flagged: by("flagged"), quiet: by("quiet") },
    excluded,
    citations,
  };
}
