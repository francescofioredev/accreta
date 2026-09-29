import {
  closeSync,
  existsSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { parsePage } from "@accreta/core";

export const SKILL_NAME = "accreta-setup";

/** Frontmatter sits at the top; a longer read buys nothing and a huge file costs. */
const READ_LIMIT = 64 * 1024;

export interface InstalledSkill {
  /** Where it was found, as a reader in the current directory would type it. */
  where: string;
  floor: { ok: true; requires: string } | { ok: false; reason: string };
}

export interface SkillSearch {
  installed: InstalledSkill[];
  /** The project directories searched, relative to the current one, nearest first. */
  levels: string[];
  globals: string[];
  /** Directories whose contents could not be listed, so absence there is not known. */
  unsearchable: { label: string; code: string }[];
}

interface SkillDirectory {
  label: string;
  path: string;
}

/**
 * `npx skills` 1.7.0 writes `.agents/skills`, or Claude Code's own for a Claude-only copy, where it
 * runs; Claude Code and Codex load both from every directory up to the repository root.
 */
export function findInstalledSkills(from: string): SkillSearch {
  const cwd = physical(from);
  // Bun caches homedir() at startup; Node, and so the skills CLI, re-reads HOME.
  const home = physical(process.env.HOME || homedir());
  const levels = projectLevels(cwd, home);
  const claudeConfig = process.env.CLAUDE_CONFIG_DIR?.trim();
  const globals: SkillDirectory[] = [
    { label: "~/.agents/skills", path: join(home, ".agents", "skills") },
    claudeConfig
      ? { label: "$CLAUDE_CONFIG_DIR/skills", path: join(claudeConfig, "skills") }
      : { label: "~/.claude/skills", path: join(home, ".claude", "skills") },
  ];
  const directories = levels.flatMap((dir) =>
    [".agents", ".claude"].map((agent) => ({
      label: join(relative(cwd, dir), agent, "skills"),
      path: join(dir, agent, "skills"),
    })),
  );

  const seen = new Set<string>();
  const installed: InstalledSkill[] = [];
  const unsearchable: SkillSearch["unsearchable"] = [];
  for (const dir of [...directories, ...globals]) {
    const probe = probeSkill(dir);
    if (probe && "code" in probe) {
      unsearchable.push({ label: dir.label, code: probe.code });
      continue;
    }
    if (!probe || seen.has(probe.key)) continue;
    seen.add(probe.key);
    installed.push(probe.skill);
  }
  return {
    installed,
    levels: levels.map((dir) => (dirname(dir) === dir ? dir : relative(cwd, dir) || ".")),
    globals: globals.map((dir) => dir.label),
    unsearchable,
  };
}

/** Symlinks resolved, so a HOME reached through one still matches the directories walked. */
function physical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/** From here up to the repository root. Home is left to the global labels, which name it plainly. */
function projectLevels(cwd: string, home: string): string[] {
  const levels: string[] = [];
  for (let dir = cwd; dir !== home; dir = dirname(dir)) {
    levels.push(dir);
    if (existsSync(join(dir, ".git")) || dirname(dir) === dir) break;
  }
  return levels;
}

/** Null only when nothing is there; `code` when a parent kept us from knowing. */
function probeSkill(
  dir: SkillDirectory,
): { key: string; skill: InstalledSkill } | { code: string } | null {
  const entry = join(dir.path, SKILL_NAME);
  const where = `${dir.label}/${SKILL_NAME}`;
  const broken = (key: string, reason: string) => ({
    key,
    skill: { where, floor: { ok: false as const, reason } },
  });

  let link;
  try {
    link = lstatSync(entry);
  } catch (error) {
    const code = errorCode(error);
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    // lstat fails otherwise only on the path leading here, which says nothing about the skill.
    return { code };
  }
  const linkKey = `${link.dev}:${link.ino}`;

  try {
    statSync(entry);
  } catch (error) {
    const code = errorCode(error);
    return link.isSymbolicLink() && code === "ENOENT"
      ? broken(linkKey, "it is a symlink to something that is gone")
      : broken(linkKey, `it could not be read — ${code}`);
  }

  const file = join(entry, "SKILL.md");
  try {
    const stat = statSync(file);
    // Keyed on the file itself, so a symlinked agent directory and its canonical copy count once.
    const key = `${stat.dev}:${stat.ino}`;
    if (!stat.isFile()) return broken(key, "it could not be read — SKILL.md is not a file");
    return { key, skill: { where, floor: readFloor(readHead(file)) } };
  } catch (error) {
    const code = errorCode(error);
    return code === "ENOENT"
      ? broken(linkKey, "it has no SKILL.md")
      : broken(linkKey, `it could not be read — ${code}`);
  }
}

function readHead(file: string): string {
  const fd = openSync(file, "r");
  try {
    const buffer = Buffer.alloc(READ_LIMIT);
    return buffer.toString("utf-8", 0, readSync(fd, buffer, 0, READ_LIMIT, 0));
  } finally {
    closeSync(fd);
  }
}

function errorCode(error: unknown): string {
  return (error as NodeJS.ErrnoException).code ?? String(error);
}

const RELEASE = /^\d+\.\d+\.\d+$/;

function readFloor(text: string): InstalledSkill["floor"] {
  const page = parsePage(text, SKILL_NAME);
  if (page.frontmatterError) {
    return { ok: false, reason: `its frontmatter did not parse — ${page.frontmatterError}` };
  }
  const metadata = page.frontmatter.metadata;
  const requires =
    metadata !== null && typeof metadata === "object"
      ? (metadata as Record<string, unknown>).requires
      : undefined;
  if (requires === undefined) return { ok: false, reason: "it declares no metadata.requires" };
  if (typeof requires !== "string" || !RELEASE.test(requires)) {
    return { ok: false, reason: `metadata.requires is ${JSON.stringify(requires)}, not a release` };
  }
  return { ok: true, requires };
}

const VERSION = /^(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/**
 * Numeric on the three parts, as `scripts/check-version.ts` compares; build metadata ignored and a
 * prerelease below its release. Two prereleases of one release tie: a floor is never one.
 */
export function compareVersions(a: string, b: string): number | null {
  const [left, right] = [VERSION.exec(a), VERSION.exec(b)];
  if (!left || !right) return null;
  for (let i = 1; i <= 3; i++) {
    const diff = Number(left[i]) - Number(right[i]);
    if (diff !== 0) return diff;
  }
  if (Boolean(left[4]) === Boolean(right[4])) return 0;
  return left[4] ? -1 : 1;
}
