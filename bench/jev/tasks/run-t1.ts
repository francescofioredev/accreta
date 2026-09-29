#!/usr/bin/env bun
/**
 * T1 tier R. Stages, resumable from the cache:
 *   --stage=jev     deterministic arms and Jev at every level
 *   --stage=haiku   Haiku at the level Jev's calibration RFCs selected
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { haiku } from "../lib/haiku.ts";
import { jev } from "../lib/jev.ts";
import { RESULTS } from "../lib/paths.ts";
import { pool } from "../lib/pool.ts";
import type { Decision } from "../lib/questions.ts";
import { shuffle } from "../lib/rng.ts";
import { auroc } from "../lib/stats.ts";
import {
  LEVELS,
  loadCases,
  normativeCount,
  packs,
  PROTOCOL,
  QUESTIONS,
  sectionLength,
  stateFor,
  type T1Case,
} from "./t1-triage.ts";

export interface T1Row {
  id: string;
  rfc: string;
  split: string;
  label: boolean;
  chars: number;
  arm: string;
  config: string;
  p: number | null;
  latency_ms: number;
  input_tokens: number;
  cost_usd: number;
  questions_per_call: number;
  error?: string;
}

export const HAIKU_TEST_SAMPLE = 600;
const stage = process.argv.find((a) => a.startsWith("--stage="))?.slice(8);
const cases = loadCases();
const file = (name: string) => join(RESULTS, `r-t1-${name}.json`);
const row = (
  c: T1Case,
  arm: string,
  config: string,
  p: number | null,
  d?: Decision,
  share = 1,
): T1Row => ({
  id: c.id,
  rfc: c.rfc,
  split: c.split,
  label: c.label,
  chars: c.chars,
  arm,
  config,
  p,
  latency_ms: d?.latency_ms ?? 0,
  input_tokens: (d?.input_tokens ?? 0) / share,
  cost_usd: (d?.cost_usd ?? 0) / share,
  questions_per_call: share,
  ...(d?.error ? { error: d.error } : {}),
});

export function selectLevel(rows: T1Row[]): string {
  const levels = [...new Set(rows.filter((r) => r.arm === "jev").map((r) => r.config))];
  return levels
    .map((config) => {
      const cal = rows.filter(
        (r) => r.arm === "jev" && r.config === config && r.split === "calibration" && r.p !== null,
      );
      return {
        config,
        auc: auroc(
          cal.map((r) => r.p!),
          cal.map((r) => r.label),
        ),
        tokens: cal.reduce((s, r) => s + r.input_tokens, 0) / cal.length,
      };
    })
    .sort((a, b) => b.auc - a.auc || a.tokens - b.tokens)[0]!.config;
}

async function runLevel(arm: "jev" | "haiku", level: string, subset: T1Case[]): Promise<T1Row[]> {
  const call = arm === "jev" ? jev : haiku;
  const limit = arm === "jev" ? 16 : Number(process.env.HAIKU_CONCURRENCY ?? 12);
  if (level === "P") {
    const groups = packs(subset);
    const out = await pool(groups, limit, (g) => call(g.state, g.questions), `${arm} P`);
    return out.flatMap((d, gi) =>
      groups[gi]!.cases.map((c, i) =>
        row(c, arm, "P", d.answers[`s${i + 1}`]?.p ?? null, d, groups[gi]!.cases.length),
      ),
    );
  }
  const out = await pool(
    subset,
    limit,
    (c) => call(stateFor(c, level as "S0"), QUESTIONS),
    `${arm} ${level}`,
  );
  return out.map((d, i) => row(subset[i]!, arm, level, d.answers.cite_worthy?.p ?? null, d));
}

mkdirSync(RESULTS, { recursive: true });
if (stage === "jev") {
  const rows: T1Row[] = [];
  for (const c of cases)
    rows.push(
      row(c, "normative-count", "-", normativeCount(c)),
      row(c, "section-length", "-", sectionLength(c)),
    );
  for (const level of LEVELS) rows.push(...(await runLevel("jev", level, cases)));
  const selected = selectLevel(rows.filter((r) => !r.error));
  writeFileSync(
    file("jev"),
    JSON.stringify({ run_at: new Date().toISOString(), protocol: PROTOCOL, selected, rows }) + "\n",
  );
  console.log(
    `jev: ${rows.length} rows, ${rows.filter((r) => r.error).length} errors, selected ${selected}`,
  );
} else if (stage === "haiku") {
  const selected = JSON.parse(readFileSync(file("jev"), "utf8")).selected as string;
  // A per-section level is ~2,900 calls; Haiku then runs on the calibration RFCs and a seeded test sample.
  const subset =
    selected === "P"
      ? cases
      : [
          ...cases.filter((c) => c.split === "calibration"),
          ...shuffle(
            cases.filter((c) => c.split === "test"),
            20261002,
          ).slice(0, HAIKU_TEST_SAMPLE),
        ];
  const rows = await runLevel("haiku", selected, subset);
  writeFileSync(
    file("haiku"),
    JSON.stringify({ run_at: new Date().toISOString(), selected, rows }) + "\n",
  );
  console.log(`haiku: ${rows.length} rows, ${rows.filter((r) => r.error).length} errors`);
} else {
  console.error("usage: bun bench/jev/tasks/run-t1.ts --stage=jev|haiku");
  process.exit(1);
}
