import { beforeAll, expect, test } from "bun:test";
import {
  changedPath,
  measure,
  measureDrift,
  type DriftMode,
  type DriftRow,
  type ListTool,
  type Row,
} from "../mcp-budget.ts";

// The smallest round size where every list tool has more results than one default page.
const GATE_PAGES = 60;

// ADR-0007: every list tool returns at most 50 entries by default.
const ADR_LIMIT = 50;

// Bytes at GATE_PAGES plus 10%, rounded up to 100; search plus 18 B per hit, like the rest.
const BUDGET = {
  search: 7_400,
  searchAliased: 9_000,
  findConsumers: 9_300,
  findConsumersMixed: 9_300,
  findCanonical: 10_300,
  lint: 9_600,
  getPageEnvelope: 1_100,
} satisfies Partial<Record<keyof Row, number>>;

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

// check_drift is not paged, so it is gated on its size at 100 pages and 50 changed paths, and on
// what one more page or one more changed path adds. Measured bytes; the budget is 10% more.
const DRIFT_TOLERANCE = 1.1;
const DRIFT: { name: string; mode: DriftMode; base: number; perPage: number; perPath: number }[] = [
  {
    name: "without diffs",
    mode: { diffing: false, revisions: 1, citesPerPage: 1 },
    base: 7_163,
    perPage: 40,
    perPath: 38,
  },
  {
    name: "without diffs, 2 revisions",
    mode: { diffing: false, revisions: 2, citesPerPage: 2 },
    base: 9_192,
    perPage: 40,
    perPath: 76,
  },
  {
    name: "with diffs, as git",
    mode: { diffing: true, revisions: 1, citesPerPage: 1 },
    base: 27_490,
    perPage: 240.92,
    perPath: 38,
  },
  {
    name: "with diffs, 2 revisions and 2 citations per page",
    mode: { diffing: true, revisions: 2, citesPerPage: 2 },
    base: 45_581,
    perPage: 396.68,
    perPath: 76,
  },
];

/** Each changed path appears once per stale revision, plus once per citation that names it. */
function expectPathsOnce(drift: DriftRow, changed: number): void {
  for (let i = 0; i < changed; i++) {
    const path = changedPath(i);
    const want = drift.staleRevisions + (drift.listedCitations.get(path) ?? 0);
    expect(drift.text.split(path).length - 1, path).toBe(want);
  }
}

test.each(DRIFT)("check_drift $name stays within its budgets", async (c) => {
  const [base, morePages, morePaths] = await Promise.all([
    measureDrift(100, 50, c.mode),
    measureDrift(200, 50, c.mode),
    measureDrift(100, 100, c.mode),
  ]);
  expectPathsOnce(base, 50);
  expectPathsOnce(morePages, 50);
  expectPathsOnce(morePaths, 100);
  expect(base.bytes).toBeLessThanOrEqual(c.base * DRIFT_TOLERANCE);
  expect((morePages.bytes - base.bytes) / 100).toBeLessThanOrEqual(c.perPage * DRIFT_TOLERANCE);
  expect((morePaths.bytes - base.bytes) / 50).toBeLessThanOrEqual(c.perPath * DRIFT_TOLERANCE);
});
