import { expect, test } from "bun:test";

// Without the condition a stale dist/ would answer for the code under test (ADR-0016).
test("@accreta/core resolves to its source inside the repository", () => {
  expect(import.meta.resolve("@accreta/core")).toEndWith("/packages/core/src/index.ts");
  expect(import.meta.resolve("@accreta/core/runtime")).toEndWith("/packages/core/src/runtime.ts");
});
