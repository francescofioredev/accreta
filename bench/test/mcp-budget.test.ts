import { expect, test } from "bun:test";
import { measure, serialize } from "../mcp-budget.ts";

test("serialize refuses a pending Promise", () => {
  expect(() => serialize("tool", Promise.resolve({ count: 1 }))).toThrow(/Promise/);
});

test("serialize refuses an empty body", () => {
  for (const empty of [{}, [], "", null, undefined]) {
    expect(() => serialize("tool", empty)).toThrow(/empty body/);
  }
});

test("serialize counts the bytes the server would send", () => {
  expect(serialize("tool", { a: 1 })).toBe(Buffer.byteLength('{\n  "a": 1\n}'));
});

test("every probe hits the corpus, and lint reports one finding per page", async () => {
  // measure throws if any probe misses, so resolving is the content check.
  const row = await measure(10);
  expect(row.lintFindings).toBe(10);
  expect(row.lint).toBeGreaterThan(1024);
});
