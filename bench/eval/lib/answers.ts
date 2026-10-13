import { shuffle } from "../../jev/lib/rng.ts";
import type { Session } from "./agent.ts";
import { toCsv } from "./csv.ts";
import { interval, mcnemarExact, type GateVerdict, type Interval, type McNemar } from "./stats.ts";

export const QUESTIONS_REQUIRED = 30;
export const ALPHA = 0.05;

export interface Question {
  id: string;
  question: string;
  /** The answer a grader checks against, written before any run. */
  reference: string;
  /** Where in the sources the reference answer is, as `source:path#Lstart-Lend`. */
  evidence: string[];
  category?: string;
}

/** Every problem at once; `exact` is the count the protocol pre-registers. */
export function validateQuestions(raw: unknown, exact = QUESTIONS_REQUIRED): Question[] {
  if (!Array.isArray(raw)) throw new Error("questions: expected an array");
  const problems: string[] = [];
  if (raw.length !== exact) problems.push(`expected ${exact} questions, found ${raw.length}`);
  const seen = new Set<string>();
  raw.forEach((q: Partial<Question>, i) => {
    const at = `question ${i + 1}${q?.id ? ` (${q.id})` : ""}`;
    for (const f of ["id", "question", "reference"] as const) {
      if (typeof q?.[f] !== "string" || q[f]!.trim() === "") problems.push(`${at}: no ${f}`);
    }
    if (!Array.isArray(q?.evidence) || q.evidence.length === 0) problems.push(`${at}: no evidence`);
    if (q?.id && seen.has(q.id)) problems.push(`${at}: duplicate id`);
    if (q?.id) seen.add(q.id);
  });
  if (problems.length > 0) throw new Error(`questions:\n  ${problems.join("\n  ")}`);
  return raw as Question[];
}

export const answerPrompt = (q: Question) =>
  [
    "Answer this question about the codebase. Be brief.",
    "After the answer, write a line `Sources:` and list each place you relied on as",
    "`source:path#Lstart-Lend`, one per line, or write `Sources: none`.",
    "",
    `Question: ${q.question}`,
  ].join("\n");

/** The places an answer cites, from its last `Sources:` block. */
export function extractSources(answer: string): string[] {
  const lines = answer.split("\n");
  const at = lines.findLastIndex((l) => /^\s*\**sources:?\**/i.test(l));
  if (at < 0) return [];
  const first = lines[at]!.replace(/^\s*\**sources:?\**:?/i, "");
  return [first, ...lines.slice(at + 1)]
    .map((l) => l.replace(/^\s*[-*]\s*/, "").trim())
    .filter((l) => l !== "" && !/^none\.?$/i.test(l));
}

export const SHEET_COLUMNS = [
  "item",
  "question",
  "reference",
  "evidence",
  "answer",
  "sources",
  "correct",
  "sources_correct",
  "notes",
] as const;

export interface KeyRow {
  item: string;
  question: string;
  arm: string;
}

/** A blind sheet: rows shuffled, arms behind opaque item ids, the key kept in a separate file. */
export function gradingSheet(
  questions: readonly Question[],
  sessions: readonly Session[],
  seed: number,
): { csv: string; key: KeyRow[] } {
  const byId = new Map(questions.map((q) => [q.id, q]));
  const order = shuffle([...sessions], seed);
  const key: KeyRow[] = [];
  const rows = order.map((s, i) => {
    const q = byId.get(s.item);
    if (!q) throw new Error(`session for unknown question "${s.item}"`);
    const item = `A${String(i + 1).padStart(3, "0")}`;
    key.push({ item, question: q.id, arm: s.arm });
    const answer = s.is_error ? `[no answer: the session failed]\n${s.result}` : s.result;
    const sources = extractSources(s.result).join("\n");
    return [item, q.question, q.reference, q.evidence.join("\n"), answer, sources, "", "", ""];
  });
  return { csv: toCsv([[...SHEET_COLUMNS], ...rows]), key };
}

interface Graded {
  question: string;
  arm: string;
  correct: boolean;
  cites: boolean;
  sourcesCorrect: boolean | null;
}

const bit = (v: string | undefined) =>
  v?.trim() === "1" ? true : v?.trim() === "0" ? false : null;

/** Join the filled sheet to its key; a blank or malformed grade stops the score. */
export function readGrades(
  rows: readonly Record<string, string>[],
  key: readonly KeyRow[],
): Graded[] {
  const byItem = new Map(rows.map((r) => [r.item, r]));
  const problems: string[] = [];
  const out = key.flatMap((k): Graded[] => {
    const r = byItem.get(k.item);
    if (!r) return (problems.push(`${k.item}: missing from the sheet`), []);
    const correct = bit(r.correct);
    const cites = (r.sources ?? "").trim() !== "";
    const sourcesCorrect = bit(r.sources_correct);
    if (correct === null) problems.push(`${k.item}: correct must be 1 or 0`);
    if (cites && sourcesCorrect === null)
      problems.push(`${k.item}: sources_correct must be 1 or 0`);
    if (!cites && (r.sources_correct ?? "").trim() !== "") {
      problems.push(`${k.item}: sources_correct given for an answer that cites nothing`);
    }
    return [{ question: k.question, arm: k.arm, correct: correct ?? false, cites, sourcesCorrect }];
  });
  if (problems.length > 0) throw new Error(`grading sheet:\n  ${problems.join("\n  ")}`);
  return out;
}

export interface ArmScore {
  accuracy: Interval;
  /** Answers that cite anything. */
  citing: Interval;
  /** Of those, the ones whose cited places support the answer. */
  sourcesCorrect: Interval;
}

export interface AnswersScore {
  arms: Record<string, ArmScore>;
  pairs: number;
  /** `b`: only the knowledge-base arm right; `c`: only the baseline right. */
  mcnemar: McNemar;
  /** #133: more accurate with the knowledge base, one-sided exact McNemar below ALPHA. */
  gate: GateVerdict;
}

export function scoreAnswers(
  graded: readonly Graded[],
  withKb: string,
  without: string,
): AnswersScore {
  const arms: Record<string, ArmScore> = {};
  for (const arm of [withKb, without]) {
    const g = graded.filter((x) => x.arm === arm);
    const citing = g.filter((x) => x.cites);
    arms[arm] = {
      accuracy: interval(g.filter((x) => x.correct).length, g.length),
      citing: interval(citing.length, g.length),
      sourcesCorrect: interval(citing.filter((x) => x.sourcesCorrect).length, citing.length),
    };
  }
  const right = (arm: string) =>
    new Map(graded.filter((x) => x.arm === arm).map((x) => [x.question, x.correct]));
  const [a, b] = [right(withKb), right(without)];
  const paired = [...a.keys()].filter((q) => b.has(q));
  const only = (x: Map<string, boolean>, y: Map<string, boolean>) =>
    paired.filter((q) => x.get(q) && !y.get(q)).length;
  const mcnemar = mcnemarExact(only(a, b), only(b, a));
  const better = arms[withKb]!.accuracy.rate > arms[without]!.accuracy.rate;
  const gate: GateVerdict =
    paired.length === 0
      ? "no data"
      : better && mcnemar.pAGreater < ALPHA
        ? "met"
        : better
          ? "not shown"
          : "failed";
  return { arms, pairs: paired.length, mcnemar, gate };
}
