import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Session } from "../lib/agent.ts";
import { costReport, priceOf, PRICES, sessionCost } from "../lib/cost.ts";

const JEV = join(import.meta.dir, "..", "..", "jev", "results");
const recorded = ["r-a-ingest.json", "r-c-ingest.json"].flatMap(
  (f) => (JSON.parse(readFileSync(join(JEV, f), "utf-8")) as { sessions: Session[] }).sessions,
);

test("a dated model id takes its family's price; an unpriced model is an error", () => {
  expect(priceOf("claude-haiku-4-5-20251001")).toBe(PRICES["claude-haiku-4-5"]!);
  expect(priceOf("claude-opus-5-5")).toBe(PRICES["claude-opus-5-5"]!);
  expect(() => priceOf("claude-opus-5")).toThrow(/no price/);
});

test("the recomputation matches the CLI's own cost on bench/jev's recorded ingest sessions", () => {
  expect(recorded).toHaveLength(9);
  for (const s of recorded) expect(Math.abs(sessionCost(s) - s.total_cost_usd)).toBeLessThan(0.005);
});

test("without per-model usage, the session's model and its 1-hour share price it", () => {
  const s: Session = {
    arm: "a",
    item: "i",
    model: "claude-opus-5-5",
    result: "",
    is_error: false,
    num_turns: 1,
    total_cost_usd: 0,
    usage: {
      input_tokens: 1e6,
      cache_creation_input_tokens: 1e6,
      cache_read_input_tokens: 1e6,
      output_tokens: 1e6,
      cache_creation: { ephemeral_1h_input_tokens: 5e5, ephemeral_5m_input_tokens: 5e5 },
    },
  };
  expect(sessionCost(s)).toBeCloseTo(4 + 6.5 + 0.2 + 20, 6);
  const r = costReport([s, s], 4, 10);
  expect(r).toMatchObject({ sessions: 2, pages: 4, validCitations: 10 });
  expect(r.perPage).toBeCloseTo((2 * 30.7) / 4, 6);
  expect(r.perValidCitation).toBeCloseTo((2 * 30.7) / 10, 6);
});
