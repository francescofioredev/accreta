import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAnswers } from "../answers.ts";
import type { Session } from "../lib/agent.ts";
import {
  extractSources,
  gradingSheet,
  readGrades,
  scoreAnswers,
  validateQuestions,
  type KeyRow,
} from "../lib/answers.ts";
import { parseCsv, readTable, toCsv } from "../lib/csv.ts";

const FIXTURES = join(import.meta.dir, "fixtures");

test("csv round-trips commas, quotes and newlines", () => {
  const rows = [
    ["a", 'say "hi", twice'],
    ["line\none", ""],
  ];
  expect(parseCsv(toCsv(rows))).toEqual(rows);
  expect(readTable("x,y\r\n1,2\r\n,\r\n")).toEqual([{ x: "1", y: "2" }]);
});

describe("questions", () => {
  test("the registered count is 30, and every problem is reported at once", () => {
    const q = { id: "q", question: "Why?", reference: "Because.", evidence: ["a:b#L1"] };
    expect(() => validateQuestions([q])).toThrow(/expected 30 questions, found 1/);
    expect(() => validateQuestions([q, { ...q, evidence: [] }], 2)).toThrow(
      /no evidence[\s\S]*duplicate id/,
    );
    expect(validateQuestions([q], 1)).toHaveLength(1);
  });

  test("sources are read from the last Sources block", () => {
    expect(extractSources("x\nSources:\n- a:b#L1\nc:d#L2-L3")).toEqual(["a:b#L1", "c:d#L2-L3"]);
    expect(extractSources("x\n**Sources:** a:b#L1")).toEqual(["a:b#L1"]);
    expect(extractSources("x\nSources: none")).toEqual([]);
    expect(extractSources("no block")).toEqual([]);
  });
});

const session = (item: string, arm: string, result: string): Session => ({
  arm,
  item,
  model: "m",
  result,
  is_error: false,
  num_turns: 1,
  total_cost_usd: 0,
  usage: {
    input_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    output_tokens: 0,
  },
});

describe("scoring", () => {
  // n paired questions; `onlyKb` right only with the KB, `onlyBase` right only without.
  const grades = (n: number, onlyKb: number, onlyBase: number) =>
    Array.from({ length: n }, (_, i) => [
      {
        question: `q${i}`,
        arm: "kb",
        correct: i < onlyKb || i >= onlyKb + onlyBase,
        cites: true,
        sourcesCorrect: true,
      },
      { question: `q${i}`, arm: "base", correct: i >= onlyKb, cites: false, sourcesCorrect: null },
    ]).flat();

  test("five discordant pairs all one way pass one-sided; four do not", () => {
    expect(scoreAnswers(grades(30, 5, 0), "kb", "base").gate).toBe("met");
    const four = scoreAnswers(grades(30, 4, 0), "kb", "base");
    expect(four.gate).toBe("not shown");
    expect(four.mcnemar).toMatchObject({ b: 4, c: 0 });
    expect(scoreAnswers(grades(30, 2, 2), "kb", "base").gate).toBe("failed");
  });

  test("intervals for accuracy, citing and citation correctness", () => {
    const s = scoreAnswers(grades(30, 6, 0), "kb", "base");
    expect(s.arms.kb!.accuracy).toMatchObject({ k: 30, n: 30 });
    expect(s.arms.base!.accuracy).toMatchObject({ k: 24, n: 30 });
    expect(s.arms.base!.citing).toMatchObject({ k: 0, n: 30 });
    expect(s.arms.kb!.sourcesCorrect.clopperPearson[0]).toBeGreaterThan(0.88);
    expect(s.pairs).toBe(30);
  });

  test("the sheet is blind and a blank grade stops the score", () => {
    const qs = validateQuestions(
      [{ id: "q1", question: "Q?", reference: "R.", evidence: ["a:b#L1"] }],
      1,
    );
    const { csv, key } = gradingSheet(
      qs,
      [session("q1", "kb", "R.\nSources: a:b#L1"), session("q1", "base", "R.\nSources: none")],
      7,
    );
    expect(csv).not.toMatch(/\bkb\b|\bbase\b/);
    const rows = readTable(csv);
    expect(rows.map((r) => r.item)).toEqual(["A001", "A002"]);
    expect(() => readGrades(rows, key)).toThrow(/correct must be 1 or 0/);
    for (const r of rows) {
      r.correct = "1";
      if (r.sources) r.sources_correct = "1";
    }
    expect(
      readGrades(rows, key)
        .map((g) => g.cites)
        .toSorted(),
    ).toEqual([false, true]);
    rows.find((r) => !r.sources)!.sources_correct = "1";
    expect(() => readGrades(rows, key)).toThrow(/cites nothing/);
  });
});

test("dry run: the with/without runner writes sessions, a sheet and its key, and scores", async () => {
  const out = mkdtempSync(join(tmpdir(), "accreta-eval-answers-"));
  try {
    for (const baseline of ["closed-book", "repo-tools"]) {
      const run = await runAnswers({
        questions: join(FIXTURES, "questions.json"),
        arms: join(FIXTURES, "arms.json"),
        withKb: "with-kb",
        baseline,
        canned: join(FIXTURES, "answers-canned.json"),
        out: join(out, baseline),
        seed: 1,
      });
      expect(run.count).toBe(6);
      const key = JSON.parse(readFileSync(run.key, "utf-8")) as KeyRow[];
      expect(new Set(key.map((k) => k.arm))).toEqual(new Set(["with-kb", baseline]));
      // A stand-in grader: right when the answer holds the reference's key term.
      const term = ["egistration order", "If-None-Match", "304"];
      const rows = readTable(readFileSync(run.sheet, "utf-8")).map((r) => ({
        ...r,
        correct: term.some((t) => r.reference?.includes(t) && r.answer?.includes(t)) ? "1" : "0",
        sources_correct: r.sources ? "1" : "",
      }));
      const s = scoreAnswers(readGrades(rows, key), "with-kb", baseline);
      expect(s.arms["with-kb"]!.accuracy).toMatchObject({ k: 3, n: 3 });
      expect(s.arms[baseline]!.accuracy.k).toBe(baseline === "closed-book" ? 1 : 2);
      expect(s.pairs).toBe(3);
    }
    await expect(
      runAnswers({
        questions: join(FIXTURES, "questions.json"),
        arms: join(FIXTURES, "arms.json"),
        withKb: "with-kb",
        baseline: "closed-book",
        live: true,
        out,
        seed: 1,
      }),
    ).rejects.toThrow(/expected 30 questions/);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
