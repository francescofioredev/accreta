#!/usr/bin/env bun
/** Run T3 tier R over every arm and write one row per item per arm to results/. */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { haiku } from "../lib/haiku.ts";
import { jev } from "../lib/jev.ts";
import { RESULTS } from "../lib/paths.ts";
import { pool } from "../lib/pool.ts";
import type { Decision } from "../lib/questions.ts";
import { loadCases, normativeRegex, PROTOCOL, QUESTIONS, whitespaceOnly } from "./t3-errata.ts";

export interface Row {
  id: string;
  split: string;
  label: string;
  arm: string;
  sample: number;
  p: number | null;
  served_by: string;
  latency_ms: number;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  error?: string;
}

const arms = new Set(
  (
    process.argv.find((a) => a.startsWith("--arms="))?.slice(7) ??
    "deterministic,jev,jev-repeat,haiku"
  ).split(","),
);
const cases = await loadCases();
const rows: Row[] = [];
const row = (
  c: (typeof cases)[number],
  arm: string,
  sample: number,
  d: Partial<Decision> & { p: number | null },
): Row => ({
  id: c.id,
  split: c.split,
  label: c.label,
  arm,
  sample,
  p: d.p,
  served_by: d.served_by ?? "",
  latency_ms: d.latency_ms ?? 0,
  input_tokens: d.input_tokens ?? 0,
  output_tokens: d.output_tokens ?? 0,
  cost_usd: d.cost_usd ?? 0,
  ...(d.error ? { error: d.error } : {}),
});

if (arms.has("deterministic")) {
  for (const c of cases) {
    rows.push(row(c, "whitespace-only", 0, { p: whitespaceOnly(c.orig, c.corrected) ? 1 : 0 }));
    rows.push(row(c, "normative-regex", 0, { p: normativeRegex(c.orig, c.corrected) ? 1 : 0 }));
  }
}
const fromDecision = (d: Decision) => ({ ...d, p: d.answers.meaning_changed?.p ?? null });
if (arms.has("jev")) {
  const out = await pool(cases, 16, (c) => jev(c.state, QUESTIONS), "jev");
  out.forEach((d, i) => rows.push(row(cases[i]!, "jev", 0, fromDecision(d))));
}
if (arms.has("jev-repeat")) {
  const repeat = ["technical", "editorial"].flatMap((l) =>
    cases
      .filter((c) => c.split === "test" && c.label === l)
      .slice(0, PROTOCOL.repeat_items_per_class),
  );
  const out = await pool(repeat, 16, (c) => jev(c.state, QUESTIONS, 1), "jev-repeat");
  out.forEach((d, i) => rows.push(row(repeat[i]!, "jev", 1, fromDecision(d))));
}
if (arms.has("haiku")) {
  const out = await pool(cases, 8, (c) => haiku(c.state, QUESTIONS), "haiku");
  out.forEach((d, i) => rows.push(row(cases[i]!, "haiku", 0, fromDecision(d))));
}

mkdirSync(RESULTS, { recursive: true });
const file = join(RESULTS, `r-t3-${[...arms].sort().join("+")}.json`);
writeFileSync(
  file,
  JSON.stringify(
    { run_at: new Date().toISOString(), protocol: PROTOCOL, questions: QUESTIONS, rows },
    null,
    0,
  ) + "\n",
);
const errors = rows.filter((r) => r.error).length;
console.log(`${rows.length} rows, ${errors} errors → ${file}`);
