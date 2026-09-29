#!/usr/bin/env bun
/** T2 tier A: Jev at every level, Haiku and the Opus annotator at the primary level. */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { claude, haiku } from "../lib/haiku.ts";
import { jev } from "../lib/jev.ts";
import { RESULTS } from "../lib/paths.ts";
import { pool } from "../lib/pool.ts";
import { LEVELS, loadPairs, PROTOCOL, QUESTIONS, stateFor, type Level } from "./t2-atlas.ts";

const arms = new Set(
  (process.argv.find((a) => a.startsWith("--arms="))?.slice(7) ?? "jev,haiku,opus").split(","),
);
const pairs = loadPairs();
const rows: object[] = [];
const push = (arm: string, level: Level, out: Awaited<ReturnType<typeof jev>>[]) =>
  out.forEach((d, i) =>
    rows.push({
      id: pairs[i]!.id,
      kind: pairs[i]!.kind,
      run: pairs[i]!.run,
      arm,
      level,
      choice: d.answers.verdict?.choice ?? null,
      probabilities: d.answers.verdict?.probabilities ?? null,
      latency_ms: d.latency_ms,
      input_tokens: d.input_tokens,
      cost_usd: d.cost_usd,
      ...(d.error ? { error: d.error } : {}),
    }),
  );
if (arms.has("jev"))
  for (const level of LEVELS)
    push(
      "jev",
      level,
      await pool(pairs, 16, (p) => jev(stateFor(p, level), QUESTIONS), `jev ${level}`),
    );
const primary = PROTOCOL.primary_level as Level;
if (arms.has("haiku"))
  push(
    "haiku",
    primary,
    await pool(pairs, 10, (p) => haiku(stateFor(p, primary), QUESTIONS), "haiku"),
  );
if (arms.has("opus"))
  push(
    "opus",
    primary,
    await pool(
      pairs,
      6,
      (p) => claude(PROTOCOL.annotator, stateFor(p, primary), QUESTIONS),
      "opus",
    ),
  );
mkdirSync(RESULTS, { recursive: true });
writeFileSync(
  join(RESULTS, `r-t2-atlas-${[...arms].sort().join("+")}.json`),
  JSON.stringify({ run_at: new Date().toISOString(), protocol: PROTOCOL, rows }) + "\n",
);
console.log(`${rows.length} rows, ${rows.filter((r: any) => r.error).length} errors`);
