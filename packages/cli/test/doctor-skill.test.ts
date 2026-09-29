import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/main.ts";
import { CLI_VERSION, compareVersions } from "../src/commands/skill-floor.ts";

let base = "";
let root = "";
let home = "";
let output: string[] = [];
const saved = { HOME: process.env.HOME, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR };

async function doctor(): Promise<number> {
  output = [];
  return run(["doctor"], { cwd: root, out: (line) => output.push(line), err: () => {} });
}

/** The `skill` section only, so a finding elsewhere in doctor cannot satisfy an assertion. */
function skillSection(): string {
  const text = output.join("\n");
  return text.slice(text.indexOf("\nskill\n"));
}

function installSkill(dir: string, frontmatter: string): void {
  mkdirSync(join(dir, "accreta-setup"), { recursive: true });
  writeFileSync(
    join(dir, "accreta-setup", "SKILL.md"),
    `---\nname: accreta-setup\ndescription: Set up accreta.\n${frontmatter}---\n\n# Setup\n`,
    "utf-8",
  );
}

const requiring = (version: string) => `metadata:\n  requires: "${version}"\n`;

beforeEach(async () => {
  base = mkdtempSync(join(tmpdir(), "accreta-doctor-skill-"));
  root = join(base, "project");
  home = join(base, "home");
  mkdirSync(root);
  mkdirSync(home);
  process.env.HOME = home;
  delete process.env.CLAUDE_CONFIG_DIR;
  delete process.env.ACCRETA_ROOT;
  delete process.env.ACCRETA_INDEX_PATH;
  await run(["init"], { cwd: root, out: () => {}, err: () => {} });
  rmSync(join(root, "sources", "example.yaml"), { force: true });
});

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(base, { recursive: true, force: true });
});

describe("accreta doctor: the installed skill's floor", () => {
  test("a floor this release meets is ok", async () => {
    installSkill(join(root, ".agents", "skills"), requiring(CLI_VERSION));

    expect(await doctor()).toBe(0);
    expect(skillSection()).toContain(
      `ok: .agents/skills/accreta-setup found, requires ${CLI_VERSION}`,
    );
  });

  test("a floor above this release is stale, names both versions, and does not fail", async () => {
    installSkill(join(root, ".claude", "skills"), requiring("99.0.0"));

    expect(await doctor()).toBe(0);
    expect(skillSection()).toContain(
      `stale: .claude/skills/accreta-setup requires 99.0.0, this is ${CLI_VERSION}`,
    );
    expect(skillSection()).toContain(`tree/v${CLI_VERSION}/skills/accreta-setup`);
  });

  test("no skills directory anywhere is unknown, not missing", async () => {
    expect(await doctor()).toBe(0);
    expect(skillSection()).toContain(
      "unknown: no accreta-setup in .agents/skills, .claude/skills, ~/.agents/skills, ~/.claude/skills",
    );
    expect(skillSection()).not.toContain("missing");
  });

  test("a skill without metadata.requires is unknown", async () => {
    installSkill(join(root, ".agents", "skills"), "");

    expect(await doctor()).toBe(0);
    expect(skillSection()).toContain(
      "unknown: .agents/skills/accreta-setup found, but it declares no metadata.requires",
    );
  });

  test("a floor that is not a release is unknown rather than compared", async () => {
    installSkill(join(root, ".agents", "skills"), "metadata:\n  requires: latest\n");

    await doctor();
    expect(skillSection()).toContain('metadata.requires is "latest", not a release');
  });

  test("frontmatter that does not parse is unknown, not thrown", async () => {
    installSkill(join(root, ".agents", "skills"), "metadata: [unclosed\n");

    expect(await doctor()).toBe(0);
    expect(skillSection()).toContain("its frontmatter did not parse");
  });

  test("a global install is found under the home directory", async () => {
    installSkill(join(home, ".claude", "skills"), requiring(CLI_VERSION));

    await doctor();
    expect(skillSection()).toContain("ok: ~/.claude/skills/accreta-setup found");
  });

  test("CLAUDE_CONFIG_DIR moves Claude Code's global directory, as it does for the skills CLI", async () => {
    const config = join(base, "claude-config");
    process.env.CLAUDE_CONFIG_DIR = config;
    installSkill(join(config, "skills"), requiring(CLI_VERSION));

    await doctor();
    expect(skillSection()).toContain("ok: $CLAUDE_CONFIG_DIR/skills/accreta-setup found");
  });

  test("a symlinked agent directory and its canonical copy are reported once", async () => {
    installSkill(join(root, ".agents", "skills"), requiring(CLI_VERSION));
    mkdirSync(join(root, ".claude", "skills"), { recursive: true });
    symlinkSync(
      join("..", "..", ".agents", "skills", "accreta-setup"),
      join(root, ".claude", "skills", "accreta-setup"),
    );

    await doctor();
    expect(skillSection().match(/accreta-setup found/g)).toHaveLength(1);
  });

  test("copies in two places are each reported", async () => {
    installSkill(join(root, ".agents", "skills"), requiring(CLI_VERSION));
    installSkill(join(home, ".agents", "skills"), requiring("99.0.0"));

    await doctor();
    expect(skillSection()).toContain("ok: .agents/skills/accreta-setup");
    expect(skillSection()).toContain("stale: ~/.agents/skills/accreta-setup requires 99.0.0");
  });
});

describe("compareVersions", () => {
  test("compares numerically, not as strings", () => {
    expect(compareVersions("0.1.10", "0.1.9")).toBeGreaterThan(0);
    expect(compareVersions("0.2.0", "0.10.0")).toBeLessThan(0);
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
  });

  test("a prerelease compares as its release", () => {
    expect(compareVersions("0.2.0", "0.2.0-rc.1")).toBe(0);
  });
});
