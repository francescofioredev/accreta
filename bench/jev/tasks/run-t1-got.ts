#!/usr/bin/env bun
/** T1 tier C: deterministic scores, Jev at every level, Haiku at the level calibration selects. */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { haiku } from "../lib/haiku.ts";
import { jev } from "../lib/jev.ts";
import { RESULTS } from "../lib/paths.ts";
import { pool } from "../lib/pool.ts";
import type { Decision } from "../lib/questions.ts";
import { auroc } from "../lib/stats.ts";
import { LEVELS, loadUnits, packs, QUESTIONS, stateFor, type Unit } from "./t1-got.ts";

const units = loadUnits();
const rows: any[] = [];
const row = (u: Unit, arm: string, config: string, p: number | null, d?: Decision, share = 1) => ({
  id: u.id,
  rfc: u.path,
  split: u.split,
  label: u.label,
  chars: u.chars,
  arm,
  config,
  p,
  latency_ms: d?.latency_ms ?? 0,
  input_tokens: (d?.input_tokens ?? 0) / share,
  cost_usd: (d?.cost_usd ?? 0) / share,
  questions_per_call: share,
  ...(d?.error ? { error: d.error } : {}),
});
async function level(arm: "jev" | "haiku", lvl: string) {
  const call = arm === "jev" ? jev : haiku;
  if (lvl === "P") {
    const groups = packs(units);
    const out = await pool(
      groups,
      arm === "jev" ? 16 : 8,
      (g) => call(g.state, g.questions),
      `${arm} P`,
    );
    out.forEach((d, gi) =>
      groups[gi]!.units.forEach((u, i) =>
        rows.push(row(u, arm, "P", d.answers[`u${i + 1}`]?.p ?? null, d, groups[gi]!.units.length)),
      ),
    );
  } else {
    const out = await pool(
      units,
      arm === "jev" ? 16 : 10,
      (u) => call(stateFor(u, lvl as "U0", units), QUESTIONS),
      `${arm} ${lvl}`,
    );
    out.forEach((d, i) => rows.push(row(units[i]!, arm, lvl, d.answers.cite_worthy?.p ?? null, d)));
  }
}
for (const u of units)
  rows.push(row(u, "exported", "-", u.exported ? 1 : 0), row(u, "unit-length", "-", u.chars));
for (const l of LEVELS) await level("jev", l);
const selected = LEVELS.map((config) => {
  const cal = rows.filter(
    (r) => r.arm === "jev" && r.config === config && r.split === "calibration" && r.p !== null,
  );
  return {
    config,
    auc: auroc(
      cal.map((r) => r.p),
      cal.map((r) => r.label),
    ),
    tokens: cal.reduce((s, r) => s + r.input_tokens, 0) / cal.length,
  };
}).sort((a, b) => b.auc - a.auc || a.tokens - b.tokens)[0]!.config;
await level("haiku", selected);
mkdirSync(RESULTS, { recursive: true });
writeFileSync(
  join(RESULTS, "r-t1-got.json"),
  JSON.stringify({ run_at: new Date().toISOString(), selected, rows }) + "\n",
);
console.log(
  `${rows.length} rows, ${rows.filter((r) => r.error).length} errors, selected ${selected}`,
);
