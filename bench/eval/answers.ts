// Answers with and without the knowledge base: run, blind two-pass grading sheets, score.
// Commands run, disagreements and score; protocol.md gives each one's flags.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { dryAgent, liveAgent, readArms, runArms, type Canned } from "./lib/agent.ts";
import {
  agreement,
  answerPrompt,
  disagreementSheet,
  gradingSheets,
  readGrades,
  scoreAnswers,
  sha256,
  validateQuestions,
  type KeyRow,
} from "./lib/answers.ts";
import { readTable } from "./lib/csv.ts";

const readJson = <T>(path: string) => JSON.parse(readFileSync(path, "utf-8")) as T;
const table = (path: string) => readTable(readFileSync(path, "utf-8"));

/** Neither directory may hold the other: a grader handed the sheets must not find the key. */
export function separateDirs(out: string, keyOut: string): void {
  const [a, b] = [resolve(out), resolve(keyOut)];
  const inside = (x: string, y: string) => !relative(y, x).startsWith("..");
  if (inside(a, b) || inside(b, a))
    throw new Error("--key-out must be a directory apart from --out");
}

export interface RunOptions {
  questions: string;
  arms: string;
  withKb: string;
  baseline: string;
  out: string;
  keyOut: string;
  canned?: string;
  live?: boolean;
  seed?: string;
  /** Live runs only: the pre-registered hashes the seed and the questions file must match. */
  seedSha256?: string;
  questionsSha256?: string;
}

export async function runAnswers(o: RunOptions) {
  separateDirs(o.out, o.keyOut);
  const bytes = readFileSync(o.questions);
  const raw = JSON.parse(bytes.toString("utf-8")) as unknown[];
  if (o.live) {
    if (!o.seed || sha256(o.seed) !== o.seedSha256) {
      throw new Error("a live run needs --seed whose SHA-256 is the pre-registered --seed-sha256");
    }
    if (sha256(bytes) !== o.questionsSha256) {
      throw new Error("the questions file's SHA-256 is not the pre-registered --questions-sha256");
    }
  }
  // A dry run checks the plumbing on any number of questions; a live one must be the registered 30.
  const questions = validateQuestions(raw, o.live ? undefined : raw.length);
  const all = readArms(o.arms);
  const arms = [o.withKb, o.baseline].map((id) => {
    const arm = all.find((a) => a.id === id);
    if (!arm) throw new Error(`no arm "${id}" in ${o.arms}`);
    return arm;
  });
  if (!o.live && !o.canned) throw new Error("pass --canned <file> for a dry run, or --live");
  const agent = o.live ? liveAgent : dryAgent(readJson<Canned>(o.canned!));
  const sessions = await runArms(
    agent,
    arms,
    questions.map((q) => ({ id: q.id, prompt: answerPrompt(q) })),
  );
  const sheets = gradingSheets(questions, sessions, o.seed ?? "dry run");
  mkdirSync(o.out, { recursive: true });
  mkdirSync(o.keyOut, { recursive: true });
  const paths = {
    correct: join(o.out, "sheet-correct.csv"),
    sources: join(o.out, "sheet-sources.csv"),
    key: join(o.keyOut, "key.json"),
    sessions: join(o.keyOut, "sessions.json"),
  };
  writeFileSync(paths.correct, sheets.correct);
  writeFileSync(paths.sources, sheets.sources);
  writeFileSync(paths.key, JSON.stringify(sheets.key, null, 2));
  writeFileSync(paths.sessions, JSON.stringify({ arms, sessions }, null, 2));
  return { count: sessions.length, questionsSha256: sha256(bytes), ...paths };
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
      "key-out": { type: "string" },
      seed: { type: "string" },
      "seed-sha256": { type: "string" },
      "questions-sha256": { type: "string" },
      first: { type: "string" },
      second: { type: "string" },
      settled: { type: "string" },
      sources: { type: "string" },
      key: { type: "string" },
    },
  });
  const print = (x: unknown) => console.log(JSON.stringify(x, null, 2));
  if (command === "run" && v.questions && v.arms && v.baseline && v.out && v["key-out"]) {
    print(
      await runAnswers({
        questions: v.questions,
        arms: v.arms,
        withKb: v.with!,
        baseline: v.baseline,
        out: v.out,
        keyOut: v["key-out"],
        canned: v.canned,
        live: v.live,
        seed: v.seed,
        seedSha256: v["seed-sha256"],
        questionsSha256: v["questions-sha256"],
      }),
    );
  } else if (command === "disagreements" && v.first && v.second && v.key && v.out) {
    const first = table(v.first);
    const found = agreement(first, table(v.second), readJson<KeyRow[]>(v.key));
    writeFileSync(v.out, disagreementSheet(first, found.disagreements));
    print(found);
  } else if (command === "score" && v.first && v.second && v.sources && v.key && v.baseline) {
    const key = readJson<KeyRow[]>(v.key);
    const sheets = {
      first: table(v.first),
      second: table(v.second),
      sources: table(v.sources),
      ...(v.settled ? { settled: table(v.settled) } : {}),
    };
    print({
      agreement: agreement(sheets.first, sheets.second, key),
      ...scoreAnswers(readGrades(sheets, key), v.with!, v.baseline),
    });
  } else {
    console.error("usage: answers.ts run|disagreements|score (see the header of this file)");
    process.exit(2);
  }
}
