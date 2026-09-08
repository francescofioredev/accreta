import { expect, test } from "bun:test";
import {
  PUBLISHABLE,
  floorTooNew,
  mismatches,
  skillRequires,
  versionOf,
} from "../scripts/check-version.ts";

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

test("a tag that cannot satisfy the setup skill is refused", () => {
  // The skill installs from git and the CLI from npm, so it can name a command
  // no published version has — sending a reader mid-setup to something they
  // cannot install. The floor is the only thing standing between them and that.
  expect(floorTooNew("0.0.1")).toContain(`requires ${skillRequires()}`);
});

test("a floor older than the tag is not a disagreement", () => {
  // A skill using nothing new is right to keep its floor. Only ahead is a bug.
  expect(floorTooNew("99.0.0")).toBeNull();
});

test("the setup skill declares a floor at all", () => {
  expect(skillRequires()).toMatch(/^\d+\.\d+\.\d+$/);
});

test("the matching tag reports nothing", () => {
  expect(mismatches(versionOf("packages/cli"))).toEqual([]);
});

test("the workflow publishes the packages in dependency order", async () => {
  // A dependent published before its dependency is a broken install for anyone
  // who runs `npm i` in that window, and the window is real: npm takes the
  // packages one at a time. The workflow's loop and this list have to agree.
  const workflow = await Bun.file(
    new URL("../.github/workflows/publish.yml", import.meta.url),
  ).text();

  const loop = workflow.match(/for package in ([^;]+);/);
  expect(loop).not.toBeNull();
  expect(loop![1]!.trim().split(/\s+/)).toEqual(PUBLISHABLE);
});
