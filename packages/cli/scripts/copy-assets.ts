#!/usr/bin/env bun
import { cpSync, existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Bring the shipped assets inside the package, and take them out again.
 *
 * `templates/` and `skills/` live at the repository root because that is where
 * the documentation points and where people edit them. npm packs nothing from
 * outside a package directory, so before packing they have to be copied in;
 * `prepack` calls this, `postpack --clean` reverses it.
 *
 * The copies are gitignored. Committing them would create a second set that
 * drifts from the originals, and nothing would report the divergence.
 */

const PACKAGE = join(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = join(PACKAGE, "..", "..");
const ASSETS = ["templates", "skills"] as const;

const clean = process.argv.includes("--clean");

for (const asset of ASSETS) {
  const destination = join(PACKAGE, asset);

  // Always remove first. Copying over an existing directory leaves files that
  // were deleted upstream in place, so a preset removed from templates/ would
  // go on shipping forever.
  rmSync(destination, { recursive: true, force: true });
  if (clean) continue;

  const source = join(REPO_ROOT, asset);
  if (!existsSync(source)) {
    throw new Error(`Cannot copy "${asset}" into the package: ${source} does not exist.`);
  }
  cpSync(source, destination, { recursive: true });
}
