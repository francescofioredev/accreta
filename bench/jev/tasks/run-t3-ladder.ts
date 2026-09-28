#!/usr/bin/env bun
/**
 * Amendment 1 runs. Stages, each resumable from the cache:
 *   --stage=ladder   Jev on every level × form, all items
 *   --stage=haiku    Haiku on the configuration Jev's calibration split selected
 *   --stage=l3       Jev and Haiku on the claim subsample
 *   --stage=batch    Jev at the selected level, K items per call, test split
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { haiku } from "../lib/haiku.ts";
import { jev } from "../lib/jev.ts";
import { DATA, RESULTS } from "../lib/paths.ts";
import { pool } from "../lib/pool.ts";
import type { Decision } from "../lib/questions.ts";
import { shuffle } from "../lib/rng.ts";
import { auroc } from "../lib/stats.ts";
import { loadCases, type T3Case } from "./t3-errata.ts";
import {
  AMENDMENT,
  FORMS,
  l3State,
  L3_QUESTIONS,
  LEVELS,
  packed,
  pChanged,
  questionsFor,
  stateFor,
  type Form,
  type Level,
} from "./t3-ladder.ts";

export interface LadderRow {
  id: string;
  split: string;
  label: string;
  arm: string;
  config: string;
  batch_k: number;
  p: number | null;
  served_by: string;
  latency_ms: number;
  input_tokens: number;
  cost_usd: number;
  error?: string;
}

const stage = process.argv.find((a) => a.startsWith("--stage="))?.slice(8);
const cases = await loadCases();
const file = (name: string) => join(RESULTS, `r-t3-ladder-${name}.json`);
const save = (name: string, rows: LadderRow[], extra: object = {}) => {
  mkdirSync(RESULTS, { recursive: true });
  writeFileSync(
    file(name),
    JSON.stringify({ run_at: new Date().toISOString(), amendment: AMENDMENT, ...extra, rows }) +
      "\n",
  );
  console.log(`${name}: ${rows.length} rows, ${rows.filter((r) => r.error).length} errors`);
};
const row = (
  c: T3Case,
  arm: string,
  config: string,
  d: Decision,
  p: number | null,
  k = 1,
  share = 1,
): LadderRow => ({
  id: c.id,
  split: c.split,
  label: c.label,
  arm,
  config,
  batch_k: k,
  p,
  served_by: d.served_by,
  latency_ms: d.latency_ms,
  input_tokens: d.input_tokens / share,
  cost_usd: d.cost_usd / share,
  ...(d.error ? { error: d.error } : {}),
});

/** The pre-registered selection: best AUROC on calibration, ties to the cheaper state. */
export function selectConfig(rows: LadderRow[]): string {
  const configs = [...new Set(rows.map((r) => r.config))];
  const scored = configs.map((config) => {
    const cal = rows.filter(
      (r) => r.config === config && r.split === "calibration" && r.p !== null,
    );
    const tokens = cal.reduce((s, r) => s + r.input_tokens, 0) / cal.length;
    return {
      config,
      auc: auroc(
        cal.map((r) => r.p!),
        cal.map((r) => r.label === "technical"),
      ),
      tokens,
    };
  });
  scored.sort((a, b) => b.auc - a.auc || a.tokens - b.tokens);
  return scored[0]!.config;
}

const ladderRows = (): LadderRow[] => JSON.parse(readFileSync(file("jev"), "utf8")).rows;

if (stage === "ladder") {
  const rows: LadderRow[] = [];
  for (const level of LEVELS)
    for (const form of FORMS) {
      const out = await pool(
        cases,
        16,
        (c) => jev(stateFor(c, level), questionsFor(form)),
        `jev ${level}-${form}`,
      );
      out.forEach((d, i) =>
        rows.push(
          row(cases[i]!, "jev", `${level}-${form}`, d, pChanged(d.answers.meaning_changed)),
        ),
      );
    }
  save("jev", rows, { selected: selectConfig(rows.filter((r) => !r.error)) });
} else if (stage === "haiku") {
  const selected = selectConfig(ladderRows().filter((r) => !r.error));
  const [level, form] = selected.split("-") as [Level, Form];
  const rows: LadderRow[] = [];
  const out = await pool(
    cases,
    Number(process.env.HAIKU_CONCURRENCY ?? 16),
    (c) => haiku(stateFor(c, level), questionsFor(form)),
    `haiku ${selected}`,
  );
  out.forEach((d, i) =>
    rows.push(row(cases[i]!, "haiku", selected, d, pChanged(d.answers.meaning_changed))),
  );
  save("haiku", rows, { selected });
} else if (stage === "l3") {
  const { items } = JSON.parse(readFileSync(join(DATA, "t3-claims.json"), "utf8")) as {
    items: { id: string; claim: string }[];
  };
  const byId = new Map(cases.map((c) => [c.id, c]));
  const subset = items.filter((i) => i.claim).map((i) => ({ c: byId.get(i.id)!, claim: i.claim }));
  const rows: LadderRow[] = [];
  const j = await pool(subset, 16, (s) => jev(l3State(s.c, s.claim), L3_QUESTIONS), "jev L3");
  j.forEach((d, i) =>
    rows.push(row(subset[i]!.c, "jev", "L3-noul", d, pChanged(d.answers.claim_invalidated))),
  );
  const h = await pool(
    subset,
    Number(process.env.HAIKU_CONCURRENCY ?? 16),
    (s) => haiku(l3State(s.c, s.claim), L3_QUESTIONS),
    "haiku L3",
  );
  h.forEach((d, i) =>
    rows.push(row(subset[i]!.c, "haiku", "L3-noul", d, pChanged(d.answers.claim_invalidated))),
  );
  save("l3", rows);
} else if (stage === "batch") {
  const level = selectConfig(ladderRows().filter((r) => !r.error)).split("-")[0] as Level;
  const test = shuffle(
    cases.filter((c) => c.split === "test"),
    AMENDMENT.batch_seed,
  );
  const rows: LadderRow[] = [];
  for (const k of AMENDMENT.batch_sizes) {
    const chunks = Array.from({ length: Math.ceil(test.length / k) }, (_, i) =>
      test.slice(i * k, i * k + k),
    );
    const out = await pool(
      chunks,
      16,
      (chunk) => {
        const { state, questions } = packed(chunk, level);
        return jev(state, questions);
      },
      `batch k=${k}`,
    );
    out.forEach((d, ci) =>
      chunks[ci]!.forEach((c, j) =>
        rows.push(
          row(
            c,
            "jev",
            `${level}-packed`,
            d,
            pChanged(d.answers[`e${j + 1}`]),
            k,
            chunks[ci]!.length,
          ),
        ),
      ),
    );
  }
  save("batch", rows, { level });
} else {
  console.error("usage: bun bench/jev/tasks/run-t3-ladder.ts --stage=ladder|haiku|l3|batch");
  process.exit(1);
}
