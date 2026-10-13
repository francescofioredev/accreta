import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Session } from "../lib/agent.ts";
import { costReport, priceOf, PRICES, sessionCost, sessionsOfArm } from "../lib/cost.ts";

const JEV = join(import.meta.dir, "..", "..", "jev", "results");
const recorded = ["r-a-ingest.json", "r-c-ingest.json"].flatMap(
  (f) => (JSON.parse(readFileSync(join(JEV, f), "utf-8")) as { sessions: Session[] }).sessions,
);
// The final result event of #136's dry-run ingest, usage fields only.
const honoDry = {
  arm: "ingest",
  item: "dry-run",
  result: "",
  ...JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "hono-dry-result.json"), "utf-8")),
} as Session;

const session = (usage: Partial<Session["usage"]>, model?: string): Session => ({
  arm: "a",
  item: "i",
  model,
  result: "",
  is_error: false,
  num_turns: 1,
  total_cost_usd: 0,
  usage: {
    input_tokens: 1e6,
    cache_creation_input_tokens: 1e6,
    cache_read_input_tokens: 1e6,
    output_tokens: 1e6,
    ...usage,
  },
});
const SPLIT = { ephemeral_1h_input_tokens: 5e5, ephemeral_5m_input_tokens: 5e5 };

describe("the price table", () => {
  test("writes are 1.25x and 2x input; reads 0.05x on Opus and Sonnet 5.5, 0.1x elsewhere", () => {
    for (const [id, p] of Object.entries(PRICES)) {
      expect(p.cache_write_5m).toBeCloseTo(1.25 * p.input, 9);
      expect(p.cache_write_1h).toBeCloseTo(2 * p.input, 9);
      const read = id === "claude-opus-5-5" || id === "claude-sonnet-5-5" ? 0.05 : 0.1;
      expect(p.cache_read).toBeCloseTo(read * p.input, 9);
    }
  });

  test("dated and tagged ids take their family's price; an unpriced model is an error", () => {
    expect(priceOf("claude-haiku-4-5-20251001")).toBe(PRICES["claude-haiku-4-5"]!);
    expect(priceOf("claude-opus-5-5[1m]")).toBe(PRICES["claude-opus-5-5"]!);
    expect(() => priceOf("claude-opus-5")).toThrow(/no price/);
  });
});

describe("recomputed against the CLI", () => {
  test("bench/jev's nine recorded ingest sessions, to the cent", () => {
    expect(recorded).toHaveLength(9);
    for (const s of recorded) {
      expect(Math.abs(sessionCost(s) - s.total_cost_usd)).toBeLessThan(0.005);
    }
  });

  test("#136's dry-run ingest: Opus 5.5 with Haiku 5.5 alongside", () => {
    expect(Object.keys(honoDry.modelUsage!)).toEqual(["claude-haiku-5-5", "claude-opus-5-5"]);
    expect(Math.abs(sessionCost(honoDry) - 2.3760017)).toBeLessThan(0.005);
  });
});

describe("what the recomputation refuses or adjusts", () => {
  test("the session's model and its 1-hour share price a record without modelUsage", () => {
    const s = session({ cache_creation: SPLIT }, "claude-opus-5-5");
    expect(sessionCost(s)).toBeCloseTo(4 + 6.5 + 0.2 + 20, 6);
  });

  test("cache writes with no 5m/1h split, or no model at all, are errors", () => {
    expect(() => sessionCost(session({}, "claude-opus-5-5"))).toThrow(/split/);
    expect(() => sessionCost(session({ cache_creation: SPLIT }))).toThrow(/no model/);
  });

  test("US-only inference costs 1.1x on 4.6+ models; an unknown geography is an error", () => {
    const us = session({ cache_creation: SPLIT, inference_geo: "us" }, "claude-opus-5-5");
    expect(sessionCost(us)).toBeCloseTo(1.1 * 30.7, 6);
    const old = session({ cache_creation: SPLIT, inference_geo: "us" }, "claude-haiku-4-5");
    expect(sessionCost(old)).toBeCloseTo(1 + 1.625 + 0.1 + 5, 6);
    expect(() =>
      sessionCost(session({ cache_creation: SPLIT, inference_geo: "eu" }, "claude-opus-5-5")),
    ).toThrow(/geo/);
  });

  test("another model's writes are priced at 5 minutes, whatever usage's split says", () => {
    const s: Session = {
      ...session({
        cache_creation: { ephemeral_1h_input_tokens: 1e6, ephemeral_5m_input_tokens: 0 },
      }),
      modelUsage: {
        "claude-opus-5-5": {
          inputTokens: 1e6,
          outputTokens: 1e6,
          cacheReadInputTokens: 1e6,
          cacheCreationInputTokens: 1e6,
        },
        "claude-haiku-4-5-20251001": {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 1e6,
        },
      },
    };
    expect(sessionCost(s)).toBeCloseTo(4 + 8 + 0.2 + 20 + 1.25, 6);
  });
});

test("cost per page, per resolving footnote, per cited and per supported claim", () => {
  const s = session({ cache_creation: SPLIT }, "claude-opus-5-5");
  const r = costReport([s, s], {
    pages: 4,
    resolvingFootnotes: 10,
    citedClaims: 20,
    supportRate: 0.5,
  });
  expect(r.perPage).toBeCloseTo(61.4 / 4, 6);
  expect(r.perResolvingFootnote).toBeCloseTo(6.14, 6);
  expect(r.perCitedClaim).toBeCloseTo(3.07, 6);
  expect(r.perSupportedClaim).toBeCloseTo(6.14, 6);
  expect(
    costReport([s], { pages: 1, resolvingFootnotes: 1, citedClaims: 1 }).perSupportedClaim,
  ).toBeNaN();
});

test("a support rate outside 0..1 is refused; arms are never pooled", () => {
  const s = session({ cache_creation: SPLIT }, "claude-opus-5-5");
  const counts = { pages: 1, resolvingFootnotes: 1, citedClaims: 1 };
  for (const supportRate of [NaN, -0.1, 1.5]) {
    expect(() => costReport([s], { ...counts, supportRate })).toThrow(/between 0 and 1/);
  }
  const two = [s, { ...s, arm: "b" }];
  expect(() => sessionsOfArm(two)).toThrow(/pass --arm/);
  expect(sessionsOfArm(two, "b")).toHaveLength(1);
  expect(() => sessionsOfArm(two, "c")).toThrow(/no sessions/);
  expect(sessionsOfArm(recorded)).toHaveLength(9);
});
