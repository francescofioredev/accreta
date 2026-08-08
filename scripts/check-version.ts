#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Does every publishable manifest agree with the tag being released?
 *
 * npm refuses to republish a version, so a tag that disagrees with the
 * manifests produces a green workflow that shipped the wrong number and no way
 * to correct it. Cheaper to fail here.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** In dependency order: a dependent published before its dependency is broken. */
export const PUBLISHABLE = [
  "packages/core",
  "packages/adapters/fs",
  "packages/adapters/git",
  "packages/cli",
  "packages/mcp-server",
];

export function versionOf(packageDir: string): string {
  const manifest = JSON.parse(readFileSync(join(REPO_ROOT, packageDir, "package.json"), "utf-8"));
  return manifest.version;
}

/** Returns the disagreements, so the caller can report all of them at once. */
export function mismatches(expected: string): string[] {
  return PUBLISHABLE.filter((dir) => versionOf(dir) !== expected).map(
    (dir) => `  ${dir} is ${versionOf(dir)}, expected ${expected}`,
  );
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

  console.log(`All ${PUBLISHABLE.length} publishable packages are at ${expected}.`);
}
