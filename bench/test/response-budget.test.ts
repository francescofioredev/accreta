import { beforeAll, expect, test } from "bun:test";
import { measure, type ListTool, type Row } from "../mcp-budget.ts";

// The smallest round size where every list tool has more results than one default page.
const GATE_PAGES = 60;

// ADR-0007: every list tool returns at most 50 entries by default.
const ADR_LIMIT = 50;

// Bytes at GATE_PAGES plus 10%, rounded up to 100. Only lint's 8.5KB is stated in ADR-0007.
const BUDGET = {
  search: 7_800,
  findConsumers: 9_300,
  findCanonical: 10_300,
  lint: 9_600,
  getPageEnvelope: 1_100,
} satisfies Partial<Record<keyof Row, number>>;

const LIST_TOOLS: ListTool[] = ["search", "findConsumers", "findCanonical", "lint"];

let row: Row;
beforeAll(async () => {
  row = await measure(GATE_PAGES);
});

test("every list tool truncates at this size, so the gate measures the bound", () => {
  // search_pages' count is its page length (#183), but every generated page matches its probe.
  expect(row.entries.search.returned).toBeLessThan(GATE_PAGES);
  for (const tool of LIST_TOOLS.filter((t) => t !== "search")) {
    expect(row.entries[tool].returned).toBeLessThan(row.entries[tool].count);
  }
});

test.each(LIST_TOOLS)(`%s returns at most ${ADR_LIMIT} entries by default`, (tool) => {
  expect(row.entries[tool].returned).toBeLessThanOrEqual(ADR_LIMIT);
});

test.each(Object.entries(BUDGET))("%s default response stays within %d bytes", (key, budget) => {
  expect(row[key as keyof typeof BUDGET]).toBeLessThanOrEqual(budget);
});
