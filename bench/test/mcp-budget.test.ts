import { expect, test } from "bun:test";
import { checkText, measure } from "../mcp-budget.ts";

test("checkText names an unawaited Promise, which the server serializes to {}", () => {
  expect(() => checkText("tool", JSON.stringify(Promise.resolve({ count: 1 })))).toThrow(/Promise/);
});

test("checkText refuses an empty body", () => {
  for (const empty of ["{}", "[]", '""', "null", undefined]) {
    expect(() => checkText("tool", empty)).toThrow(/empty body/);
  }
});

test("checkText counts bytes, not characters", () => {
  expect(checkText("tool", '{"a": "é"}')).toBe(11);
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

test("a body too short to hold the search probe word is refused", async () => {
  await expect(measure(2, { bodyBytes: 20 })).rejects.toThrow(/at least 34.*forcing/);
  expect((await measure(2, { bodyBytes: 34 })).bodyBytes).toBe(34);
});
