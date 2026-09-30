import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/main.ts";

// Through the bin, as a user runs it; in the repository that means the source condition.
const BIN = [
  process.execPath,
  "--conditions=@accreta/source",
  join(import.meta.dir, "..", "src", "bin.ts"),
];
import { compareVersions } from "../src/commands/skill-floor.ts";

let base = "";
let repo = "";
let home = "";
let version = "";
let output: string[] = [];
const ENV_KEYS = ["HOME", "CLAUDE_CONFIG_DIR", "ACCRETA_ROOT", "ACCRETA_INDEX_PATH"] as const;
const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

async function doctor(cwd = repo): Promise<number> {
  output = [];
  return run(["doctor"], { cwd, out: (line) => output.push(line), err: () => {} });
}

async function init(cwd: string): Promise<void> {
  mkdirSync(cwd, { recursive: true });
  await run(["init"], { cwd, out: () => {}, err: () => {} });
  rmSync(join(cwd, "sources", "example.yaml"), { force: true });
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

const requiring = (floor: string) => `metadata:\n  requires: "${floor}"\n`;

beforeEach(async () => {
  base = mkdtempSync(join(tmpdir(), "accreta-doctor-skill-"));
  // A `.git` marks where the upward search stops, so nothing above the temp tree is read.
  repo = join(base, "repo");
  home = join(base, "home");
  mkdirSync(join(repo, ".git"), { recursive: true });
  mkdirSync(home);
  process.env.HOME = home;
  delete process.env.CLAUDE_CONFIG_DIR;
  delete process.env.ACCRETA_ROOT;
  delete process.env.ACCRETA_INDEX_PATH;
  output = [];
  await run(["--version"], { cwd: base, out: (line) => output.push(line), err: () => {} });
  version = output.join("").trim();
  await init(repo);
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  rmSync(base, { recursive: true, force: true });
});

describe("accreta doctor: the installed skill's floor", () => {
  test("a floor this release meets is ok", async () => {
    installSkill(join(repo, ".agents", "skills"), requiring(version));

    expect(await doctor()).toBe(0);
    expect(skillSection()).toContain(`ok: .agents/skills/accreta-setup found, requires ${version}`);
  });

  test("a floor above this release is stale, names both versions, and does not fail", async () => {
    installSkill(join(repo, ".claude", "skills"), requiring("99.0.0"));

    expect(await doctor()).toBe(0);
    expect(skillSection()).toContain(
      `stale: .claude/skills/accreta-setup requires 99.0.0, this is ${version}`,
    );
    expect(skillSection()).toContain(`tree/v${version}/skills/accreta-setup`);
  });

  test("no skills directory anywhere is unknown, not missing", async () => {
    expect(await doctor()).toBe(0);
    expect(skillSection()).toContain(
      "unknown: no accreta-setup in .agents/skills or .claude/skills here, nor in ~/.agents/skills or ~/.claude/skills",
    );
    expect(skillSection()).not.toContain("missing");
  });

  test("a skill without metadata.requires is unknown", async () => {
    installSkill(join(repo, ".agents", "skills"), "");

    expect(await doctor()).toBe(0);
    expect(skillSection()).toContain(
      "unknown: .agents/skills/accreta-setup found, but it declares no metadata.requires",
    );
  });

  test("a floor that is not a release is unknown rather than compared", async () => {
    installSkill(join(repo, ".agents", "skills"), "metadata:\n  requires: latest\n");

    await doctor();
    expect(skillSection()).toContain('metadata.requires is "latest", not a release');
  });

  test("frontmatter that does not parse is unknown, not thrown", async () => {
    installSkill(join(repo, ".agents", "skills"), "metadata: [unclosed\n");

    expect(await doctor()).toBe(0);
    expect(skillSection()).toContain("its frontmatter did not parse");
  });

  test("a global install is found under the home directory", async () => {
    installSkill(join(home, ".claude", "skills"), requiring(version));

    await doctor();
    expect(skillSection()).toContain("ok: ~/.claude/skills/accreta-setup found");
  });

  test("CLAUDE_CONFIG_DIR moves Claude Code's global directory, as it does for the skills CLI", async () => {
    const config = join(base, "claude-config");
    process.env.CLAUDE_CONFIG_DIR = config;
    installSkill(join(config, "skills"), requiring(version));

    await doctor();
    expect(skillSection()).toContain("ok: $CLAUDE_CONFIG_DIR/skills/accreta-setup found");
  });

  test("a symlinked agent directory and its canonical copy are reported once", async () => {
    installSkill(join(repo, ".agents", "skills"), requiring(version));
    mkdirSync(join(repo, ".claude", "skills"), { recursive: true });
    symlinkSync(
      join("..", "..", ".agents", "skills", "accreta-setup"),
      join(repo, ".claude", "skills", "accreta-setup"),
    );

    await doctor();
    expect(skillSection().match(/accreta-setup found/g)).toHaveLength(1);
  });

  test("copies in two places are each reported", async () => {
    installSkill(join(repo, ".agents", "skills"), requiring(version));
    installSkill(join(home, ".agents", "skills"), requiring("99.0.0"));

    await doctor();
    expect(skillSection()).toContain("ok: .agents/skills/accreta-setup");
    expect(skillSection()).toContain("stale: ~/.agents/skills/accreta-setup requires 99.0.0");
  });
});

describe("accreta doctor: a skill directory in a state nobody planned", () => {
  test("SKILL.md that is a directory is unknown, not a crash", async () => {
    mkdirSync(join(repo, ".agents", "skills", "accreta-setup", "SKILL.md"), { recursive: true });

    expect(await doctor()).toBe(0);
    expect(skillSection()).toContain(
      "unknown: .agents/skills/accreta-setup found, but it could not be read",
    );
  });

  test("SKILL.md nobody may read is unknown, not a crash", async () => {
    installSkill(join(repo, ".agents", "skills"), requiring(version));
    const file = join(repo, ".agents", "skills", "accreta-setup", "SKILL.md");
    chmodSync(file, 0o000);
    try {
      expect(await doctor()).toBe(0);
    } finally {
      chmodSync(file, 0o644);
    }
    expect(skillSection()).toContain(
      "unknown: .agents/skills/accreta-setup found, but it could not be read — EACCES",
    );
  });

  test("SKILL.md that is a FIFO is not opened, so doctor cannot hang on it", async () => {
    const dir = join(repo, ".agents", "skills", "accreta-setup");
    mkdirSync(dir, { recursive: true });
    expect(Bun.spawnSync(["mkfifo", join(dir, "SKILL.md")]).exitCode).toBe(0);

    // A blocking open cannot be interrupted in-process, so the regression must fail by timeout here.
    const child = Bun.spawn([...BIN, "doctor"], {
      cwd: repo,
      env: { ...process.env, HOME: home },
      stdout: "pipe",
      stderr: "pipe",
    });
    const timer = setTimeout(() => child.kill(), 5000);
    const exitCode = await child.exited;
    clearTimeout(timer);

    expect(child.signalCode).toBeNull();
    expect(exitCode).toBe(0);
    expect(await new Response(child.stdout).text()).toContain("SKILL.md is not a file");
  }, 15_000);

  test("a symlink left behind by a deleted canonical copy is reported as broken, not absent", async () => {
    mkdirSync(join(repo, ".claude", "skills"), { recursive: true });
    symlinkSync(
      join("..", "..", ".agents", "skills", "accreta-setup"),
      join(repo, ".claude", "skills", "accreta-setup"),
    );

    expect(await doctor()).toBe(0);
    expect(skillSection()).toContain(
      "unknown: .claude/skills/accreta-setup found, but it is a symlink to something that is gone",
    );
    expect(skillSection()).not.toContain("no accreta-setup in");
  });

  test("a skill directory nobody may enter is reported as found, not absent", async () => {
    installSkill(join(repo, ".agents", "skills"), requiring(version));
    const dir = join(repo, ".agents", "skills", "accreta-setup");
    chmodSync(dir, 0o000);
    try {
      expect(await doctor()).toBe(0);
    } finally {
      chmodSync(dir, 0o755);
    }
    expect(skillSection()).toContain(
      "unknown: .agents/skills/accreta-setup found, but it could not be read — EACCES",
    );
  });
});

describe("accreta doctor: a directory it cannot look into", () => {
  test("a locked parent directory is not a found skill", async () => {
    mkdirSync(join(home, ".claude", "skills"), { recursive: true });
    chmodSync(join(home, ".claude"), 0o000);
    try {
      expect(await doctor()).toBe(0);
    } finally {
      chmodSync(join(home, ".claude"), 0o755);
    }
    expect(skillSection()).not.toContain("found");
    expect(skillSection()).toContain("unknown: could not look in ~/.claude/skills — EACCES");
    expect(skillSection()).toContain("unknown: no accreta-setup in");
  });
});

describe("accreta doctor: a knowledge base under the home directory", () => {
  test("the upward search stops below home, so a home copy keeps its ~ label", async () => {
    const kb = join(home, "kb");
    await init(kb);
    installSkill(join(home, ".agents", "skills"), requiring(version));

    await doctor(kb);
    expect(skillSection()).toContain("ok: ~/.agents/skills/accreta-setup found");
    expect(skillSection()).not.toContain("../.agents");
  });

  test("with nothing installed, only the workspace itself is searched below home", async () => {
    const kb = join(home, "kb");
    await init(kb);

    await doctor(kb);
    expect(skillSection()).toContain(".claude/skills here, nor in ~/.agents/skills");
  });

  test("a HOME reached through a symlink stops the search all the same", async () => {
    const link = join(base, "home-link");
    symlinkSync(home, link);
    process.env.HOME = link;
    const kb = join(realpathSync(home), "kb");
    await init(kb);
    installSkill(join(home, ".agents", "skills"), requiring(version));

    await doctor(kb);
    expect(skillSection()).toContain("ok: ~/.agents/skills/accreta-setup found");
    expect(skillSection()).not.toContain("../.agents");
  });
});

describe("accreta doctor: a knowledge base inside a larger repository", () => {
  test("a skill installed at the repository root is found from a workspace below it", async () => {
    const kb = join(repo, "kb");
    await init(kb);
    installSkill(join(repo, ".claude", "skills"), requiring(version));

    await doctor(kb);
    expect(skillSection()).toContain(`ok: ../.claude/skills/accreta-setup found`);
  });

  test("a stale copy at the repository root is not hidden by an ok copy at home", async () => {
    const kb = join(repo, "kb");
    await init(kb);
    installSkill(join(repo, ".claude", "skills"), requiring("99.0.0"));
    installSkill(join(home, ".agents", "skills"), requiring(version));

    await doctor(kb);
    expect(skillSection()).toContain("stale: ../.claude/skills/accreta-setup requires 99.0.0");
    expect(skillSection()).toContain("ok: ~/.agents/skills/accreta-setup");
  });

  test("the search stops at the repository root", async () => {
    installSkill(join(base, ".agents", "skills"), requiring(version));

    await doctor();
    expect(skillSection()).toContain("unknown: no accreta-setup in");
  });
});

describe("compareVersions", () => {
  test("compares numerically, not as strings", () => {
    expect(compareVersions("0.1.10", "0.1.9")).toBeGreaterThan(0);
    expect(compareVersions("0.2.0", "0.10.0")).toBeLessThan(0);
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
  });

  test("a prerelease is below its release", () => {
    expect(compareVersions("0.2.0-rc.1", "0.2.0")).toBeLessThan(0);
    expect(compareVersions("0.2.0", "0.2.0-rc.1")).toBeGreaterThan(0);
  });

  test("build metadata does not count", () => {
    expect(compareVersions("0.2.0+build.5", "0.2.0")).toBe(0);
  });

  test("something that is not a version cannot be compared", () => {
    expect(compareVersions("latest", "0.2.0")).toBeNull();
  });
});
