import { expect, test } from "bun:test";
import { PUBLISHABLE, mismatches, versionOf } from "../scripts/check-version.ts";

test("the publishable packages agree on one version", () => {
  // They are published together and depend on each other by version. One left
  // behind would name a dependency version that was never published.
  const versions = new Set(PUBLISHABLE.map(versionOf));
  expect([...versions]).toHaveLength(1);
});

test("a tag that disagrees with the manifests is reported, with every package named", () => {
  const wrong = mismatches("9.9.9");
  expect(wrong).toHaveLength(PUBLISHABLE.length);
  expect(wrong.join("\n")).toContain("expected 9.9.9");
});

test("the matching tag reports nothing", () => {
  expect(mismatches(versionOf("packages/cli"))).toEqual([]);
});
