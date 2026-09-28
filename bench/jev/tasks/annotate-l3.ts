#!/usr/bin/env bun
/**
 * Post-hoc second annotator for T3's claim-conditioned level: the IETF label says an erratum is
 * technical, not that a given claim became false, so L3 needs a claim-level label.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { claude } from "../lib/haiku.ts";
import { DATA, RESULTS } from "../lib/paths.ts";
import { pool } from "../lib/pool.ts";
import type { Questions } from "../lib/questions.ts";
import { loadCases } from "./t3-errata.ts";
import { l3State, L3_QUESTIONS } from "./t3-ladder.ts";

const ANNOTATOR = "claude-opus-5-5";
const ANNOTATION: Questions = {
  label: {
    type: "choice",
    instructions: L3_QUESTIONS.claim_invalidated!.instructions,
    criteria: {
      invalidated: "yes: the claim is now wrong or no longer supported",
      valid: "no: the claim still holds",
      unsure: "the texts do not allow a decision",
    },
  },
};
const { items } = JSON.parse(readFileSync(join(DATA, "t3-claims.json"), "utf8")) as {
  items: { id: string; claim: string }[];
};
const byId = new Map((await loadCases()).map((c) => [c.id, c]));
const subset = items.filter((i) => i.claim).map((i) => ({ c: byId.get(i.id)!, claim: i.claim }));
const out = await pool(
  subset,
  Number(process.env.CONCURRENCY ?? 6),
  (s) => claude(ANNOTATOR, l3State(s.c, s.claim), ANNOTATION),
  "opus-l3",
);
const rows = out.map((d, i) => ({
  id: subset[i]!.c.id,
  ietf: subset[i]!.c.label,
  annotator: d.answers.label?.choice ?? null,
  served_by: d.served_by,
  ...(d.error ? { error: d.error } : {}),
}));
mkdirSync(RESULTS, { recursive: true });
writeFileSync(
  join(RESULTS, "r-t3-annotator-l3.json"),
  JSON.stringify({
    run_at: new Date().toISOString(),
    annotator: ANNOTATOR,
    question: ANNOTATION,
    rows,
  }) + "\n",
);
console.log(`${rows.length} rows, ${rows.filter((r) => r.error).length} errors`);
