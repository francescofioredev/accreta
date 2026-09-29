import { cached } from "./cache.ts";
import type { Answer, Decision, Question, Questions } from "./questions.ts";

// Checked on the run date and recorded in each card; output tokens are not billed.
export const JEV_USD_PER_MTOK_INPUT = 0.042;
const PROXY = process.env.JEV_PROXY_URL ?? "http://127.0.0.1:8799";
const SHAPE = "cf-binding-v1";

function parse(q: Question, raw: any): Answer {
  const unit = (x: unknown) => (typeof x === "number" && x >= 0 && x <= 1 ? x : undefined);
  if (q.type === "noul") return { type: "noul", p: unit(raw?.noul) };
  const probabilities: Record<string, number> = {};
  const declared =
    q.type === "choice" ? Object.keys(q.criteria) : q.criteria.map((_, i) => String(i));
  for (const [k, v] of Object.entries(raw?.probabilities ?? {})) {
    if (declared.includes(k) && unit(v) !== undefined) probabilities[k] = v as number;
  }
  if (q.type === "choice") {
    const choice = declared.includes(raw?.choice) ? raw.choice : undefined;
    return { type: "choice", choice, probabilities, confidence: unit(raw?.confidence) };
  }
  return {
    type: "score",
    score: typeof raw?.score === "number" ? raw.score : undefined,
    probabilities,
    confidence: unit(raw?.confidence),
  };
}

async function call(state: unknown, questions: Questions): Promise<Decision> {
  const started = performance.now();
  let lastError = "";
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(PROXY, {
      method: "POST",
      body: JSON.stringify({ state, questions }),
    }).catch((e) => e as Error);
    if (res instanceof Error) lastError = String(res);
    else {
      const body: any = await res.json().catch(() => ({}));
      const inner = body?.result?.result;
      if (res.ok && inner?.answers) {
        const answers: Record<string, Answer> = {};
        for (const [name, q] of Object.entries(questions))
          answers[name] = parse(q, inner.answers[name]);
        const input = inner.usage?.input_tokens ?? 0;
        return {
          provider: "jev",
          served_by: inner.model,
          answers,
          latency_ms: body.upstream_ms ?? Math.round(performance.now() - started),
          input_tokens: input,
          output_tokens: inner.usage?.output_tokens ?? 0,
          cost_usd: (input / 1e6) * JEV_USD_PER_MTOK_INPUT,
        };
      }
      lastError = body?.error ?? `HTTP ${res.status}`;
      // A 4xx that is not a rate limit will not improve on retry.
      if (!/429|5\d\d|capacity|overload|timeout/i.test(lastError) && res.status < 500) break;
    }
    await Bun.sleep(2 ** attempt * 1000);
  }
  return {
    provider: "jev",
    served_by: "",
    answers: {},
    latency_ms: 0,
    input_tokens: 0,
    output_tokens: 0,
    cost_usd: 0,
    error: lastError,
  };
}

/** `sample` distinguishes repeated draws of the same item in the cache. */
export async function jev(state: unknown, questions: Questions, sample = 0): Promise<Decision> {
  // A failed call is not cached, so the next run retries it.
  return cached(
    "jev",
    { SHAPE, state, questions, sample },
    () => call(state, questions),
    (d) => !d.error,
  );
}
