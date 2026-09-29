import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parsePage } from "@accreta/core";

export const SKILL_NAME = "accreta-setup";

export const CLI_VERSION = (
  JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf-8")) as {
    version: string;
  }
).version;

export interface InstalledSkill {
  /** Where it was found, written the way a reader would type it. */
  where: string;
  floor: { ok: true; requires: string } | { ok: false; reason: string };
}

/**
 * Where `npx skills` 1.7.0 writes: `.agents/skills` for symlink and universal-agent installs,
 * Claude Code's own for a Claude-only copy. Other agents' copy installs are not looked for.
 */
export function skillDirectories(root: string): { label: string; path: string }[] {
  // Bun caches homedir() at startup; Node, and so the skills CLI, re-reads HOME.
  const home = process.env.HOME || homedir();
  const claudeConfig = process.env.CLAUDE_CONFIG_DIR?.trim();
  return [
    { label: ".agents/skills", path: join(root, ".agents", "skills") },
    { label: ".claude/skills", path: join(root, ".claude", "skills") },
    { label: "~/.agents/skills", path: join(home, ".agents", "skills") },
    claudeConfig
      ? { label: "$CLAUDE_CONFIG_DIR/skills", path: join(claudeConfig, "skills") }
      : { label: "~/.claude/skills", path: join(home, ".claude", "skills") },
  ];
}

export function findInstalledSkills(root: string): InstalledSkill[] {
  const seen = new Set<string>();
  const found: InstalledSkill[] = [];
  for (const dir of skillDirectories(root)) {
    const file = join(dir.path, SKILL_NAME, "SKILL.md");
    if (!existsSync(file)) continue;
    // A symlink install points the agent's directory at the canonical copy: one file, not two.
    const real = realpathSync(file);
    if (seen.has(real)) continue;
    seen.add(real);
    found.push({
      where: `${dir.label}/${SKILL_NAME}`,
      floor: readFloor(readFileSync(file, "utf-8")),
    });
  }
  return found;
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

const releaseParts = (v: string) => v.split(/[.-]/, 3).map(Number);

/** Ascending, on the three numeric parts: the ordering `scripts/check-version.ts` uses. */
export function compareVersions(a: string, b: string): number {
  const [left, right] = [releaseParts(a), releaseParts(b)];
  for (let i = 0; i < 3; i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}
