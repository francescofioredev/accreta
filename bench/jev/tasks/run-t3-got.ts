#!/usr/bin/env bun
/** T3 tier C: Jev and Haiku on touched citations; the Opus annotator on those and on the untouched sample. */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { claude, haiku } from "../lib/haiku.ts";
import { jev } from "../lib/jev.ts";
import { RESULTS } from "../lib/paths.ts";
import { pool } from "../lib/pool.ts";
import type { Questions } from "../lib/questions.ts";
import { loadItems, PROTOCOL, QUESTIONS, stateFor } from "./t3-got.ts";

const ANNOTATION: Questions = {
  label: {
    type: "choice",
    instructions: QUESTIONS.claim_invalidated!.instructions,
    criteria: {
      invalidated: "yes: the claim is now wrong or no longer supported",
      valid: "no: the claim still holds",
      unsure: "the texts do not allow a decision",
    },
  },
};
const arms = new Set(
  (process.argv.find((a) => a.startsWith("--arms="))?.slice(7) ?? "jev,haiku,opus").split(","),
);
const { touched, untouched } = loadItems();
const rows: object[] = [];
const push = (
  arm: string,
  set: typeof touched,
  out: Awaited<ReturnType<typeof jev>>[],
  pick: (d: any) => unknown,
) =>
  out.forEach((d, i) =>
    rows.push({
      id: set[i]!.id,
      split: set[i]!.split,
      fate: set[i]!.declaration_fate,
      arm,
      value: pick(d),
      latency_ms: d.latency_ms,
      input_tokens: d.input_tokens,
      cost_usd: d.cost_usd,
      ...(d.error ? { error: d.error } : {}),
    }),
  );
const pInvalid = (d: any) => d.answers.claim_invalidated?.p ?? null;
if (arms.has("jev"))
  push(
    "jev",
    touched,
    await pool(touched, 16, (t) => jev(stateFor(t), QUESTIONS), "jev"),
    pInvalid,
  );
if (arms.has("haiku"))
  push(
    "haiku",
    touched,
    await pool(touched, 10, (t) => haiku(stateFor(t), QUESTIONS), "haiku"),
    pInvalid,
  );
if (arms.has("opus")) {
  const both = [...touched, ...untouched];
  push(
    "opus",
    both,
    await pool(both, 6, (t) => claude(PROTOCOL.annotator, stateFor(t), ANNOTATION), "opus"),
    (d) => d.answers.label?.choice ?? null,
  );
}
mkdirSync(RESULTS, { recursive: true });
writeFileSync(
  join(RESULTS, `r-t3-got-${[...arms].sort().join("+")}.json`),
  JSON.stringify({ run_at: new Date().toISOString(), protocol: PROTOCOL, rows }) + "\n",
);
console.log(`${rows.length} rows, ${rows.filter((r: any) => r.error).length} errors`);
