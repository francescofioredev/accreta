import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  openIndex,
  parseConfig,
  parseSourceDeclaration,
  SourceRegistry,
  type AccretaConfig,
  type SourceAdapter,
} from "@accreta/core";
import { FsSource } from "@accreta/adapter-fs";
import { GitSource } from "@accreta/adapter-git";
import type { ToolContext } from "./tools.ts";

const CONFIG_FILENAME = "accreta.config.yaml";

function findRoot(start: string): string {
  const override = process.env.ACCRETA_ROOT;
  if (override) return resolve(override);

  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, CONFIG_FILENAME))) return dir;
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error(
        `No ${CONFIG_FILENAME} found. Set ACCRETA_ROOT to the knowledge base directory.`,
      );
    }
    dir = parent;
  }
}

function loadSources(root: string, config: AccretaConfig): Map<string, SourceAdapter> {
  const dir = join(root, "sources");
  const out = new Map<string, SourceAdapter>();
  if (!existsSync(dir)) return out;

  const registry = new SourceRegistry()
    .register(
      "fs",
      (d) =>
        new FsSource({
          id: d.id,
          root: join(root, String(d.options.root ?? ".")),
          citationFormat: config.provenanceFormat,
          extensions: Array.isArray(d.options.extensions)
            ? (d.options.extensions as string[])
            : undefined,
        }),
    )
    .register(
      "git",
      (d) =>
        new GitSource({
          id: d.id,
          root: join(root, String(d.options.root ?? ".")),
          citationFormat: config.provenanceFormat,
          paths: Array.isArray(d.options.paths) ? (d.options.paths as string[]) : undefined,
        }),
    );

  for (const name of readdirSync(dir).toSorted()) {
    if (!name.endsWith(".yaml") && !name.endsWith(".yml")) continue;
    const declaration = parseSourceDeclaration(readFileSync(join(dir, name), "utf-8"));
    out.set(declaration.id, registry.create(declaration));
  }
  return out;
}

/**
 * Assemble what the tools need.
 *
 * The index is opened read-only. The write tool edits markdown on disk and asks
 * for a reindex rather than mutating the index directly: the index is derived,
 * and a write that updated it in place would put it out of step with the pages
 * it is derived from.
 */
export function createContext(cwd: string = process.cwd()): ToolContext {
  const root = findRoot(cwd);
  const config = parseConfig(readFileSync(join(root, CONFIG_FILENAME), "utf-8"));

  const indexPath = process.env.ACCRETA_INDEX_PATH
    ? resolve(process.env.ACCRETA_INDEX_PATH)
    : join(root, ".accreta", "index.sqlite");

  if (!existsSync(indexPath)) {
    throw new Error(`No index at ${indexPath}. Run \`accreta reindex\` first.`);
  }

  return {
    db: openIndex(indexPath, { readonly: true }),
    config,
    root,
    sources: loadSources(root, config),
    // Writes are off unless explicitly enabled. Provenance is the substance of
    // the project, so the tool that can rewrite it does not exist by default.
    writesEnabled: process.env.ACCRETA_ALLOW_WRITES === "1",
  };
}
