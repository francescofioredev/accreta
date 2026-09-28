#!/usr/bin/env bun
/** T2 tier R on SciFact: Jev and Haiku, one row per pair per arm. */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { haiku } from "../lib/haiku.ts";
import { jev } from "../lib/jev.ts";
import { RESULTS } from "../lib/paths.ts";
import { pool } from "../lib/pool.ts";
import { loadPairs, PROTOCOL, QUESTIONS } from "./t2-scifact.ts";

const arms = new Set(
  (process.argv.find((a) => a.startsWith("--arms="))?.slice(7) ?? "jev,haiku").split(","),
);
const pairs = await loadPairs();
for (const arm of arms) {
  const call = arm === "jev" ? jev : haiku;
  const limit = arm === "jev" ? 16 : Number(process.env.HAIKU_CONCURRENCY ?? 16);
  const out = await pool(pairs, limit, (p) => call(p.state, QUESTIONS), arm);
  const rows = out.map((d, i) => ({
    id: pairs[i]!.id,
    split: pairs[i]!.split,
    label: pairs[i]!.label,
    arm,
    choice: d.answers.verdict?.choice ?? null,
    probabilities: d.answers.verdict?.probabilities ?? null,
    served_by: d.served_by,
    latency_ms: d.latency_ms,
    input_tokens: d.input_tokens,
    cost_usd: d.cost_usd,
    ...(d.error ? { error: d.error } : {}),
  }));
  mkdirSync(RESULTS, { recursive: true });
  writeFileSync(
    join(RESULTS, `r-t2-scifact-${arm}.json`),
    JSON.stringify({
      run_at: new Date().toISOString(),
      protocol: PROTOCOL,
      questions: QUESTIONS,
      rows,
    }) + "\n",
  );
  console.log(`${arm}: ${rows.length} rows, ${rows.filter((r) => r.error).length} errors`);
}
