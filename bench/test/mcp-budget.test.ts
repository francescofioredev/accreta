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

test("the generated body size is reported, and get_page follows it", async () => {
  const small = await measure(2, { bodyBytes: 1_000 });
  const large = await measure(2);
  expect(small.bodyBytes).toBe(1_000);
  expect(large.bodyBytes).toBe(29_889);
  expect(large.getPage - small.getPage).toBe(large.bodyBytes - small.bodyBytes);
});
