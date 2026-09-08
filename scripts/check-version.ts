#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Does every manifest agree with the tag? npm refuses to republish a version,
 * so a tag that disagrees ships the wrong number with no way to correct it.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** In dependency order: a dependent published before its dependency is broken. */
export const PUBLISHABLE = [
  "packages/core",
  "packages/adapters/fs",
  "packages/adapters/git",
  "packages/adapters/delegated",
  "packages/adapters/registry",
  "packages/cli",
  "packages/mcp-server",
];

export interface Manifest {
  name: string;
  version: string;
  dependencies?: Record<string, string>;
  repository?: { url?: string };
}

export function manifestOf(packageDir: string): Manifest {
  return JSON.parse(readFileSync(join(REPO_ROOT, packageDir, "package.json"), "utf-8"));
}

export function versionOf(packageDir: string): string {
  return manifestOf(packageDir).version;
}

export const SKILL = "skills/accreta-setup/SKILL.md";

/** A regex, not a YAML parser: this script depends on nothing, and it must stay that way. */
export function skillRequires(): string | null {
  const text = readFileSync(join(REPO_ROOT, SKILL), "utf-8");
  const frontmatter = /^---\n([\s\S]*?)\n---/.exec(text)?.[1];
  return frontmatter ? (/^\s+requires:\s*"?([^"\s]+)"?$/m.exec(frontmatter)?.[1] ?? null) : null;
}

/** Ascending, on the three numeric parts. */
function compareVersions(a: string, b: string): number {
  const parts = (v: string) => v.split(".").map(Number);
  const [left, right] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** Returns the disagreements, so the caller can report all of them at once. */
export function mismatches(expected: string): string[] {
  return PUBLISHABLE.filter((dir) => versionOf(dir) !== expected).map(
    (dir) => `  ${dir} is ${versionOf(dir)}, expected ${expected}`,
  );
}

/**
 * Kept apart from `mismatches`, which asks whether the repository is tag-ready.
 * A floor naming the release being cut is the normal state between releases.
 */
export function floorTooNew(expected: string): string | null {
  const requires = skillRequires();
  if (requires === null) return `  ${SKILL} declares no metadata.requires`;
  if (compareVersions(requires, expected) > 0)
    return `  ${SKILL} requires ${requires}, which is newer than ${expected}`;
  return null;
}

if (import.meta.main) {
  const expected = process.argv[2];
  if (!expected) {
    console.error("Usage: check-version.ts <version>   (the tag without its leading v)");
    process.exit(1);
  }

  const wrong = mismatches(expected);
  if (wrong.length > 0) {
    console.error(`Tag v${expected} does not match the manifests:\n${wrong.join("\n")}`);
    console.error("\nEither the tag or the manifests are wrong. Fix before publishing.");
    process.exit(1);
  }

  const floor = floorTooNew(expected);
  if (floor !== null) {
    console.error(`Tag v${expected} cannot satisfy the setup skill:\n${floor}`);
    console.error("\nIt installs from git, so it would name a command nobody can install yet.");
    process.exit(1);
  }

  console.log(
    `All ${PUBLISHABLE.length} publishable packages are at ${expected}, ` +
      `and the setup skill requires ${skillRequires()}.`,
  );
}
