// Answers with and without the knowledge base: run, blind grading sheet, score.
// bun bench/eval/answers.ts run --questions q.json --arms arms.json --baseline <arm> (--canned c.json | --live) --out <dir>
// bun bench/eval/answers.ts score --sheet graded.csv --key key.json --baseline <arm>
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { dryAgent, liveAgent, readArms, runArms, type Canned } from "./lib/agent.ts";
import {
  answerPrompt,
  gradingSheet,
  readGrades,
  scoreAnswers,
  validateQuestions,
  type KeyRow,
} from "./lib/answers.ts";
import { readTable } from "./lib/csv.ts";

const readJson = <T>(path: string) => JSON.parse(readFileSync(path, "utf-8")) as T;

export async function runAnswers(opts: {
  questions: string;
  arms: string;
  withKb: string;
  baseline: string;
  canned?: string;
  live?: boolean;
  out: string;
  seed: number;
}): Promise<{ count: number; sessions: string; sheet: string; key: string }> {
  const raw = readJson<unknown[]>(opts.questions);
  // A dry run checks the plumbing on any number of questions; a live one must be the registered 30.
  const questions = validateQuestions(raw, opts.live ? undefined : raw.length);
  const all = readArms(opts.arms);
  const arms = [opts.withKb, opts.baseline].map((id) => {
    const arm = all.find((a) => a.id === id);
    if (!arm) throw new Error(`no arm "${id}" in ${opts.arms}`);
    return arm;
  });
  if (!opts.live && !opts.canned) throw new Error("pass --canned <file> for a dry run, or --live");
  const agent = opts.live ? liveAgent : dryAgent(readJson<Canned>(opts.canned!));
  const sessions = await runArms(
    agent,
    arms,
    questions.map((q) => ({ id: q.id, prompt: answerPrompt(q) })),
  );
  const { csv, key } = gradingSheet(questions, sessions, opts.seed);
  mkdirSync(opts.out, { recursive: true });
  const paths = {
    sessions: join(opts.out, "sessions.json"),
    sheet: join(opts.out, "sheet.csv"),
    key: join(opts.out, "key.json"),
  };
  writeFileSync(paths.sessions, JSON.stringify({ arms, sessions }, null, 2));
  writeFileSync(paths.sheet, csv);
  writeFileSync(paths.key, JSON.stringify(key, null, 2));
  return { count: sessions.length, ...paths };
}

if (import.meta.main) {
  const [command, ...rest] = process.argv.slice(2);
  const { values: v } = parseArgs({
    args: rest,
    options: {
      questions: { type: "string" },
      arms: { type: "string" },
      with: { type: "string", default: "with-kb" },
      baseline: { type: "string" },
      canned: { type: "string" },
      live: { type: "boolean", default: false },
      out: { type: "string" },
      seed: { type: "string", default: "137" },
      sheet: { type: "string" },
      key: { type: "string" },
    },
  });
  if (command === "run" && v.questions && v.arms && v.baseline && v.out) {
    const done = await runAnswers({
      questions: v.questions,
      arms: v.arms,
      withKb: v.with!,
      baseline: v.baseline,
      canned: v.canned,
      live: v.live,
      out: v.out,
      seed: Number(v.seed),
    });
    console.log(JSON.stringify(done, null, 2));
  } else if (command === "score" && v.sheet && v.key && v.baseline) {
    const grades = readGrades(readTable(readFileSync(v.sheet, "utf-8")), readJson<KeyRow[]>(v.key));
    console.log(JSON.stringify(scoreAnswers(grades, v.with!, v.baseline), null, 2));
  } else {
    console.error("usage: answers.ts run|score (see the header of this file)");
    process.exit(2);
  }
}
