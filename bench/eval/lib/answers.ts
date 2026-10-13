import { shuffle } from "../../jev/lib/rng.ts";
import { cohenKappa } from "../../jev/lib/stats.ts";
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

const SOURCES_LINE = /^\s*\**sources:?\**/i;

/** The places an answer cites, from its last `Sources:` block. */
export function extractSources(answer: string): string[] {
  const lines = answer.split("\n");
  const at = lines.findLastIndex((l) => SOURCES_LINE.test(l));
  if (at < 0) return [];
  const first = lines[at]!.replace(/^\s*\**sources:?\**:?/i, "");
  return [first, ...lines.slice(at + 1)]
    .map((l) => l.replace(/^\s*[-*]\s*/, "").trim())
    .filter((l) => l !== "" && !/^none\.?$/i.test(l));
}

/** The answer without its `Sources:` block, so the first pass grades the answer alone. */
export function stripSources(answer: string): string {
  const lines = answer.split("\n");
  const at = lines.findLastIndex((l) => SOURCES_LINE.test(l));
  return (at < 0 ? lines : lines.slice(0, at)).join("\n").trim();
}

/** First pass: is the answer right? Two graders fill a copy each. */
export const CORRECT_COLUMNS = ["item", "question", "reference", "answer", "correct", "notes"];
/** Second pass, after the first is complete: do the cited places support the answer? */
export const SOURCES_COLUMNS = [
  "item",
  "question",
  "answer",
  "sources",
  "sources_correct",
  "notes",
];

export interface KeyRow {
  item: string;
  question: string;
  arm: string;
}

/** A shuffle seed from any string, so the value can stay secret behind its SHA-256. */
export const seedNumber = (seed: string) =>
  new Bun.CryptoHasher("sha256").update(seed).digest().readUInt32BE(0);

export const sha256 = (data: string | Uint8Array) =>
  new Bun.CryptoHasher("sha256").update(data).digest("hex");

export interface Sheets {
  correct: string;
  sources: string;
  key: KeyRow[];
}

/** Blind sheets: rows shuffled under opaque item ids; the key goes to a directory graders never open. */
export function gradingSheets(
  questions: readonly Question[],
  sessions: readonly Session[],
  seed: string,
): Sheets {
  const byId = new Map(questions.map((q) => [q.id, q]));
  const order = shuffle([...sessions], seedNumber(seed));
  const key: KeyRow[] = [];
  const correct: string[][] = [];
  const sources: string[][] = [];
  order.forEach((s, i) => {
    const q = byId.get(s.item);
    if (!q) throw new Error(`session for unknown question "${s.item}"`);
    const item = `A${String(i + 1).padStart(3, "0")}`;
    key.push({ item, question: q.id, arm: s.arm });
    const answer = s.is_error
      ? `[no answer: the session failed]\n${s.result}`
      : stripSources(s.result);
    correct.push([item, q.question, q.reference, answer, "", ""]);
    const cited = s.is_error ? [] : extractSources(s.result);
    if (cited.length > 0) sources.push([item, q.question, answer, cited.join("\n"), "", ""]);
  });
  const byItem = (a: string[], b: string[]) => (a[0]! < b[0]! ? -1 : 1);
  return {
    correct: toCsv([CORRECT_COLUMNS, ...correct]),
    sources: toCsv([SOURCES_COLUMNS, ...sources.toSorted(byItem)]),
    key,
  };
}

type Rows = readonly Record<string, string>[];

const bit = (v: string | undefined) =>
  v?.trim() === "1" ? true : v?.trim() === "0" ? false : null;

/** Every item's grade in one column, or every problem at once. */
function gradesIn(rows: Rows, items: readonly string[], column: string): Map<string, boolean> {
  const byItem = new Map(rows.map((r) => [r.item, r]));
  const problems: string[] = [];
  const out = new Map<string, boolean>();
  for (const item of items) {
    const v = bit(byItem.get(item)?.[column]);
    if (v === null) problems.push(`${item}: ${column} must be 1 or 0`);
    else out.set(item, v);
  }
  if (problems.length > 0) throw new Error(`grading sheet:\n  ${problems.join("\n  ")}`);
  return out;
}

export interface Agreement {
  /** Cohen's kappa between the two graders on `correct`. */
  kappa: number;
  disagreements: string[];
}

export function agreement(first: Rows, second: Rows, key: readonly KeyRow[]): Agreement {
  const items = key.map((k) => k.item);
  const [a, b] = [gradesIn(first, items, "correct"), gradesIn(second, items, "correct")];
  const label = (m: Map<string, boolean>) => items.map((i) => String(m.get(i)));
  return {
    kappa: cohenKappa(label(a), label(b)),
    disagreements: items.filter((i) => a.get(i) !== b.get(i)),
  };
}

/** The rows a third, blind pass settles: the first-pass columns, the graders' marks left out. */
export function disagreementSheet(first: Rows, disagreements: readonly string[]): string {
  const rows = first.filter((r) => disagreements.includes(r.item ?? ""));
  return toCsv([
    CORRECT_COLUMNS,
    ...rows.map((r) => [r.item ?? "", r.question ?? "", r.reference ?? "", r.answer ?? "", "", ""]),
  ]);
}

export interface Graded {
  question: string;
  arm: string;
  correct: boolean;
  cites: boolean;
  sourcesCorrect: boolean | null;
}

/** Final grades: agreed items as graded, disagreements as settled; none may be left open. */
export function readGrades(
  sheets: { first: Rows; second: Rows; settled?: Rows; sources: Rows },
  key: readonly KeyRow[],
): Graded[] {
  const items = key.map((k) => k.item);
  const first = gradesIn(sheets.first, items, "correct");
  const { disagreements } = agreement(sheets.first, sheets.second, key);
  const settled = disagreements.length
    ? gradesIn(sheets.settled ?? [], disagreements, "correct")
    : new Map<string, boolean>();
  const citing = sheets.sources.map((r) => r.item ?? "").filter((i) => items.includes(i));
  const sources = gradesIn(sheets.sources, citing, "sources_correct");
  return key.map((k) => ({
    question: k.question,
    arm: k.arm,
    correct: settled.get(k.item) ?? first.get(k.item)!,
    cites: sources.has(k.item),
    sourcesCorrect: sources.get(k.item) ?? null,
  }));
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
