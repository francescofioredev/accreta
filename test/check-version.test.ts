import { expect, test } from "bun:test";
import {
  PUBLISHABLE,
  floorTooNew,
  manifestOf,
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

test("every package is published after the packages it depends on", () => {
  // Internal dependencies are pinned exactly, so a dependent that goes first fails to install
  // (ETARGET) until its dependency lands, and stays broken if that later publish fails.
  const names = PUBLISHABLE.map((dir) => manifestOf(dir).name);
  const late = PUBLISHABLE.flatMap((dir, at) =>
    Object.keys(manifestOf(dir).dependencies ?? {})
      .filter((dep) => names.includes(dep) && names.indexOf(dep) > at)
      .map((dep) => `${names[at]} is published before its dependency ${dep}`),
  );
  expect(late).toEqual([]);
});

test.skipIf(process.platform === "win32")(
  "a prerelease tag publishes to next, and a release to latest",
  async () => {
    // As `latest`, an rc would reach every `npm i accreta` and every bare `npx accreta`.
    const workflow = await Bun.file(
      new URL("../.github/workflows/publish.yml", import.meta.url),
    ).text();
    expect(workflow).toContain('npm publish --access public --tag "$tag"');
    const choice = /case "\$\{version%%\+\*\}" in[\s\S]*?esac/.exec(workflow)?.[0];
    expect(choice).toBeDefined();
    const tagFor = (version: string) =>
      Bun.spawnSync(["bash", "-c", `version=${version}\n${choice}\necho "$tag"`])
        .stdout.toString()
        .trim();
    expect(tagFor("0.2.0-rc.1")).toBe("next");
    expect(tagFor("0.2.0")).toBe("latest");
    expect(tagFor("0.2.0+build-5")).toBe("latest");
  },
);
