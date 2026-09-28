#!/usr/bin/env bun
/**
 * L3 of amendment 1: a claim a documentation page could make from each erratum's original text.
 * The writer sees the original text with the changed passage marked, never the corrected text
 * or the IETF label, so the claim cannot encode the answer. Claims are committed before any judge sees them.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cached } from "../lib/cache.ts";
import { wordHunks } from "../lib/diff.ts";
import { DATA } from "../lib/paths.ts";
import { pool } from "../lib/pool.ts";
import { shuffle } from "../lib/rng.ts";
import { loadCases, type T3Case } from "../tasks/t3-errata.ts";
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";

export const WRITER = "claude-sonnet-5";
export const CLAIMS_PER_CLASS = { calibration: 25, test: 100 } as const;
const SEED = 20260929;
const CWD = join(tmpdir(), "accreta-bench-haiku");

const SYSTEM =
  "You write one sentence for a technical documentation page. It states a specific, checkable fact taken from the " +
  "given specification text, in your own words, and its truth must depend on the passage marked FOCUS. " +
  "Do not hedge, do not mention errata, corrections or the marking. Reply only with the JSON the schema requires.";

const marked = (c: T3Case) => {
  const h = wordHunks(c.orig, c.corrected, 12);
  return h
    .map((x) => `${x.before} FOCUS[ ${x.removed || "(text is inserted here)"} ] ${x.after}`)
    .join("\n…\n");
};

function write(c: T3Case): Promise<{ claim: string; cost_usd: number; error?: string }> {
  const input = `Specification: ${c.state.rfc}, section ${c.section}\n\nText:\n${c.orig}\n\nPassage with the focus marked:\n${marked(c)}`;
  const schema = {
    type: "object",
    properties: { claim: { type: "string" } },
    required: ["claim"],
    additionalProperties: false,
  };
  return cached(
    "claims-t3",
    { WRITER, SYSTEM, input },
    () =>
      new Promise((resolve) => {
        mkdirSync(CWD, { recursive: true });
        const args = [
          "-p",
          "--safe-mode",
          "--model",
          WRITER,
          "--tools",
          "",
          "--output-format",
          "json",
          "--system-prompt",
          SYSTEM,
          "--json-schema",
          JSON.stringify(schema),
        ];
        const child = spawn("claude", args, { cwd: CWD, stdio: ["pipe", "pipe", "pipe"] });
        let out = "";
        child.stdout.on("data", (d) => (out += d));
        child.on("close", () => {
          try {
            const d = JSON.parse(out);
            resolve({
              claim: (d.structured_output ?? JSON.parse(d.result)).claim,
              cost_usd: d.total_cost_usd ?? 0,
            });
          } catch (e) {
            resolve({ claim: "", cost_usd: 0, error: String(e) });
          }
        });
        child.stdin.end(input);
      }),
    (v) => !v.error && !!v.claim,
  );
}

if (import.meta.main) {
  const cases = await loadCases();
  const pick = (split: "calibration" | "test", label: string, n: number) =>
    shuffle(
      cases.filter((c) => c.split === split && c.label === label),
      SEED,
    ).slice(0, n);
  const chosen = (["technical", "editorial"] as const).flatMap((l) => [
    ...pick("calibration", l, CLAIMS_PER_CLASS.calibration),
    ...pick("test", l, CLAIMS_PER_CLASS.test),
  ]);
  const out = await pool(chosen, 8, write, "claims");
  const items = chosen.map((c, i) => ({
    id: c.id,
    split: c.split,
    label: c.label,
    claim: out[i]!.claim,
    ...(out[i]!.error ? { error: out[i]!.error } : {}),
  }));
  writeFileSync(
    join(DATA, "t3-claims.json"),
    JSON.stringify(
      { writer: WRITER, seed: SEED, per_class: CLAIMS_PER_CLASS, system: SYSTEM, items },
      null,
      1,
    ) + "\n",
  );
  console.log(
    items.length,
    "claims,",
    items.filter((i) => !i.claim).length,
    "missing, $",
    out.reduce((s, o) => s + o.cost_usd, 0).toFixed(2),
  );
}
