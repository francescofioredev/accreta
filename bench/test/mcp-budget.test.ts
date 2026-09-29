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

test("every measured tool returns a body, and lint reports its findings", async () => {
  const row = await measure(10);
  for (const bytes of [row.search, row.getPage, row.findConsumers, row.findCanonical, row.lint]) {
    expect(bytes).toBeGreaterThan(0);
  }
  // Five of the ten pages carry no provenance and a dangling link.
  expect(row.lintFindings).toBeGreaterThanOrEqual(5);
  expect(row.lint).toBeGreaterThan(1024);
});
