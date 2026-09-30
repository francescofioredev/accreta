import { beforeAll, expect, test } from "bun:test";
import { changedPath, measure, measureDrift, type ListTool, type Row } from "../mcp-budget.ts";

// The smallest round size where every list tool has more results than one default page.
const GATE_PAGES = 60;

// ADR-0007: every list tool returns at most 50 entries by default.
const ADR_LIMIT = 50;

// Bytes at GATE_PAGES plus 10%, rounded up to 100. Only lint's 8.5KB is stated in ADR-0007.
const BUDGET = {
  search: 7_800,
  searchAliased: 9_500,
  findConsumers: 9_300,
  findConsumersMixed: 9_300,
  findCanonical: 10_300,
  lint: 9_600,
  getPageEnvelope: 1_100,
} satisfies Partial<Record<keyof Row, number>>;

// check_drift's marginal bytes, measured (40 per page, 38 per changed path) plus 10%.
const DRIFT_PER_PAGE = 44;
const DRIFT_PER_PATH = 41.8;

const LIST_TOOLS: ListTool[] = [
  "search",
  "searchAliased",
  "findConsumers",
  "findConsumersMixed",
  "findCanonical",
  "lint",
];

let row: Row;
beforeAll(async () => {
  row = await measure(GATE_PAGES);
});

test("every list tool truncates at this size, so the gate measures the bound", () => {
  // search_pages' count is its page length (#183), so its matches are counted in the index.
  expect(row.searchAliasedMatches).toBe(GATE_PAGES);
  expect(row.entries.search.returned).toBeLessThan(GATE_PAGES);
  expect(row.entries.searchAliased.returned).toBeLessThan(row.searchAliasedMatches);
  for (const tool of ["findConsumers", "findConsumersMixed", "findCanonical", "lint"] as const) {
    expect(row.entries[tool].returned).toBeLessThan(row.entries[tool].count);
  }
});

test("the mixed page's default response holds outbound relations, cut by the limit", () => {
  expect(row.mixedOutbound.returned).toBeGreaterThan(0);
  expect(row.mixedOutbound.returned).toBeLessThan(row.mixedOutbound.count);
});

test.each(LIST_TOOLS)(`%s returns at most ${ADR_LIMIT} entries by default`, (tool) => {
  expect(row.entries[tool].returned).toBeLessThanOrEqual(ADR_LIMIT);
});

test.each(Object.entries(BUDGET))("%s default response stays within %d bytes", (key, budget) => {
  expect(row[key as keyof typeof BUDGET]).toBeLessThanOrEqual(budget);
});

test("check_drift names each changed path once per stale revision", async () => {
  const drift = await measureDrift(100, 50);
  for (let i = 0; i < 50; i++) {
    expect(drift.text.split(changedPath(i)).length - 1).toBe(1);
  }
});

test("check_drift grows by at most its measured cost per page and per changed path", async () => {
  const [base, morePages, morePaths] = await Promise.all([
    measureDrift(100, 50),
    measureDrift(200, 50),
    measureDrift(100, 100),
  ]);
  expect((morePages.bytes - base.bytes) / 100).toBeLessThanOrEqual(DRIFT_PER_PAGE);
  expect((morePaths.bytes - base.bytes) / 50).toBeLessThanOrEqual(DRIFT_PER_PATH);
});
