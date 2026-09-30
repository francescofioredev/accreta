#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { cpSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { manifestOf, PUBLISHABLE } from "./check-version.ts";

/**
 * Build the package in the working directory, and the packages it depends on, to `dist/`.
 * `--clean` removes what a build left. `prepack` and `postpack` call this (ADR-0016).
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TSC = join(REPO_ROOT, "node_modules", "typescript", "bin", "tsc");

/** The package and every publishable package it depends on, directly or not. */
function closure(dir: string): string[] {
  const byName = new Map(PUBLISHABLE.map((pkg) => [manifestOf(pkg).name, pkg]));
  const seen = new Set<string>();
  const visit = (pkg: string) => {
    if (seen.has(pkg)) return;
    seen.add(pkg);
    for (const name of Object.keys(manifestOf(pkg).dependencies ?? {})) {
      const dep = byName.get(name);
      if (dep) visit(dep);
    }
  };
  visit(dir);
  return [...seen];
}

/** tsc emits only TypeScript; `schema.sql` and anything else beside it is copied as is. */
function copyAssets(src: string, dist: string): void {
  for (const entry of readdirSync(src, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile() || entry.name.endsWith(".ts")) continue;
    const from = join(entry.parentPath, entry.name);
    cpSync(from, join(dist, relative(src, from)));
  }
}

const pkg = relative(REPO_ROOT, process.cwd()).split("\\").join("/");
if (!PUBLISHABLE.includes(pkg)) throw new Error(`${pkg} is not a publishable package.`);
const packages = closure(pkg);

// A dist/ left behind would be resolved by any run that forgets the @accreta/source condition.
for (const dir of packages) {
  rmSync(join(REPO_ROOT, dir, "dist"), { recursive: true, force: true });
  rmSync(join(REPO_ROOT, dir, "tsconfig.build.tsbuildinfo"), { force: true });
}

if (!process.argv.includes("--clean")) {
  const built = spawnSync(process.execPath, [TSC, "-b", "--force", "tsconfig.build.json"], {
    stdio: "inherit",
  });
  if (built.status !== 0) process.exit(built.status ?? 1);
  for (const dir of packages) {
    copyAssets(join(REPO_ROOT, dir, "src"), join(REPO_ROOT, dir, "dist"));
  }
}
