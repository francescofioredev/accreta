import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cached } from "./cache.ts";
import type { Answer, Decision, Question, Questions } from "./questions.ts";

export const HAIKU = "claude-haiku-4-5";
const SHAPE = "cli-safe-mode-v1";
// Outside the repository, so the CLI picks up no project instructions.
const CWD = join(tmpdir(), "accreta-bench-haiku");

const SYSTEM =
  "You answer typed decision questions about a state. For a yes/no question give the probability of yes. " +
  "For a choice give a probability for every option, summing to 1. Reply only with the JSON the schema requires.";

function schema(questions: Questions) {
  const properties: Record<string, unknown> = {};
  for (const [name, q] of Object.entries(questions)) {
    if (q.type === "noul") properties[name] = { type: "number", minimum: 0, maximum: 1 };
    else {
      const keys =
        q.type === "choice" ? Object.keys(q.criteria) : q.criteria.map((_, i) => String(i));
      properties[name] = {
        type: "object",
        properties: Object.fromEntries(
          keys.map((k) => [k, { type: "number", minimum: 0, maximum: 1 }]),
        ),
        required: keys,
        additionalProperties: false,
      };
    }
  }
  return {
    type: "object",
    properties,
    required: Object.keys(questions),
    additionalProperties: false,
  };
}

function prompt(state: unknown, questions: Questions): string {
  const lines = Object.entries(questions).map(([name, q]) => {
    if (q.type === "noul") return `- ${name} (yes/no): ${q.instructions}`;
    const options =
      q.type === "choice"
        ? Object.entries(q.criteria).map(([k, v]) => `    ${k}: ${v}`)
        : q.criteria.map((v, i) => `    ${i}: ${v}`);
    return `- ${name} (${q.type}): ${q.instructions}\n${options.join("\n")}`;
  });
  const s = typeof state === "string" ? state : JSON.stringify(state, null, 2);
  return `<state>\n${s}\n</state>\n\nQuestions:\n${lines.join("\n")}`;
}

function parse(q: Question, raw: any): Answer {
  if (q.type === "noul") return { type: "noul", p: typeof raw === "number" ? raw : undefined };
  const probabilities: Record<string, number> = {};
  const total =
    Object.values(raw ?? {}).reduce<number>((a, v) => a + (typeof v === "number" ? v : 0), 0) || 1;
  for (const [k, v] of Object.entries(raw ?? {}))
    if (typeof v === "number") probabilities[k] = v / total;
  const choice = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0]?.[0];
  return { type: q.type, choice, probabilities };
}

function run(args: string[], input: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("claude", args, { cwd: CWD, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) =>
      code === 0 ? resolve(out) : reject(new Error(`claude exited ${code}: ${err || out}`)),
    );
    child.stdin.end(input);
  });
}

async function call(state: unknown, questions: Questions): Promise<Decision> {
  mkdirSync(CWD, { recursive: true });
  const args = ["-p", "--safe-mode", "--model", HAIKU, "--tools", "", "--output-format", "json"];
  args.push("--system-prompt", SYSTEM, "--json-schema", JSON.stringify(schema(questions)));
  try {
    const d = JSON.parse(await run(args, prompt(state, questions)));
    const out = d.structured_output ?? JSON.parse(d.result);
    const answers: Record<string, Answer> = {};
    for (const [name, q] of Object.entries(questions)) answers[name] = parse(q, out?.[name]);
    const usage = d.modelUsage?.[HAIKU] ?? {};
    return {
      provider: "haiku",
      served_by: HAIKU,
      answers,
      latency_ms: d.duration_api_ms ?? 0,
      input_tokens: usage.inputTokens ?? d.usage?.input_tokens ?? 0,
      output_tokens: usage.outputTokens ?? d.usage?.output_tokens ?? 0,
      cost_usd: usage.costUSD ?? d.total_cost_usd ?? 0,
    };
  } catch (e) {
    return {
      provider: "haiku",
      served_by: HAIKU,
      answers: {},
      latency_ms: 0,
      input_tokens: 0,
      output_tokens: 0,
      cost_usd: 0,
      error: String(e),
    };
  }
}

/** `sample` distinguishes repeated draws of the same item in the cache. */
export function haiku(state: unknown, questions: Questions, sample = 0): Promise<Decision> {
  return cached(
    "haiku",
    { SHAPE, state, questions, sample },
    () => call(state, questions),
    (d) => !d.error,
  );
}
