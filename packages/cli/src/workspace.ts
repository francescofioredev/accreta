import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DEFAULT_CONFIG, parseConfig, type AccretaConfig } from "@accreta/core";

export const CONFIG_FILENAME = "accreta.config.yaml";

export interface Workspace {
  root: string;
  config: AccretaConfig;
  indexPath: string;
}

/**
 * Find the knowledge base a command should act on.
 *
 * Walks upward from the starting directory looking for `accreta.config.yaml`,
 * so commands work from anywhere inside a project rather than only at its root.
 * ACCRETA_ROOT overrides the search.
 */
export function findWorkspace(start: string = process.cwd()): Workspace {
  const override = process.env.ACCRETA_ROOT;
  if (override) return load(resolve(override));

  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, CONFIG_FILENAME))) return load(dir);
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error(
        `No ${CONFIG_FILENAME} found in this directory or any parent. ` +
          `Run \`accreta init\` to create one, or set ACCRETA_ROOT.`,
      );
    }
    dir = parent;
  }
}

function load(root: string): Workspace {
  const configPath = join(root, CONFIG_FILENAME);
  if (!existsSync(configPath)) {
    throw new Error(`No ${CONFIG_FILENAME} at ${root}`);
  }
  const config = parseConfig(readFileSync(configPath, "utf-8"));
  return { root, config, indexPath: indexPathFor(root) };
}

/**
 * Where the index lives.
 *
 * Inside the project by default, which is right locally and wrong in a
 * container where the project directory is a checkout something else resets.
 * ACCRETA_INDEX_PATH moves it onto its own volume.
 */
export function indexPathFor(root: string): string {
  const override = process.env.ACCRETA_INDEX_PATH;
  return override ? resolve(override) : join(root, ".accreta", "index.sqlite");
}

export { DEFAULT_CONFIG };
