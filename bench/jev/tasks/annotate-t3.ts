#!/usr/bin/env bun
/**
 * Post-hoc second annotator for T3, added after the first run exposed label noise in the IETF
 * classification. Its labels count only as far as they agree with the maintainer's blind audit.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { claude } from "../lib/haiku.ts";
import { RESULTS } from "../lib/paths.ts";
import { pool } from "../lib/pool.ts";
import type { Questions } from "../lib/questions.ts";
import { loadCases, QUESTIONS } from "./t3-errata.ts";

export const ANNOTATOR = "claude-opus-5-5";
export const ANNOTATION: Questions = {
  label: {
    type: "choice",
    instructions: QUESTIONS.meaning_changed!.instructions,
    criteria: {
      technical: "yes: the technical meaning changed",
      editorial: "no: only spelling, grammar, punctuation or layout changed",
      unsure: "the two texts do not allow a decision",
    },
  },
};

const cases = await loadCases();
const out = await pool(
  cases,
  Number(process.env.CONCURRENCY ?? 8),
  (c) => claude(ANNOTATOR, c.state, ANNOTATION),
  "opus",
);
const rows = out.map((d, i) => ({
  id: cases[i]!.id,
  ietf: cases[i]!.label,
  annotator: d.answers.label?.choice ?? null,
  probabilities: d.answers.label?.probabilities ?? null,
  served_by: d.served_by,
  cost_usd: d.cost_usd,
  ...(d.error ? { error: d.error } : {}),
}));
mkdirSync(RESULTS, { recursive: true });
writeFileSync(
  join(RESULTS, "r-t3-annotator.json"),
  JSON.stringify({
    run_at: new Date().toISOString(),
    annotator: ANNOTATOR,
    question: ANNOTATION,
    rows,
  }) + "\n",
);
console.log(`${rows.length} rows, ${rows.filter((r) => r.error).length} errors`);
