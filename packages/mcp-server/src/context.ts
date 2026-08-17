import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
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
 * The index's identity, or null if it cannot be stat'd.
 *
 * A rebuild is never observable as an absence — rename(2) replaces the path
 * atomically — so a missing file means it is genuinely gone, not mid-swap.
 */
function inodeOf(path: string): string | null {
  try {
    const stat = statSync(path);
    return `${stat.dev}:${stat.ino}`;
  } catch {
    return null;
  }
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

  let db = openIndex(indexPath, { readonly: true });
  let openedInode = inodeOf(indexPath);

  return {
    get db() {
      const current = inodeOf(indexPath);
      // A reindex replaces this file by rename(2), and a connection held across
      // that swap is undefined by platform: macOS fails it with SQLITE_IOERR
      // for the rest of the process, while Linux keeps serving the old rows off
      // the unlinked inode — silently answering with pre-rebuild data, which is
      // the worse half. build.ts says a long-lived reader must reopen; this is
      // that reader.
      //
      // Identity is checked out of band, by asking the filesystem rather than
      // the connection: a connection that is already failing cannot be asked
      // anything, and a stale one on Linux would answer with the old value. A
      // build id in `meta` would be blind in both of exactly those cases.
      if (current !== null && current !== openedInode) {
        // Open before closing, so a failed reopen leaves a working context
        // rather than a permanently dead one.
        const reopened = openIndex(indexPath, { readonly: true });
        db.close();
        db = reopened;
        openedInode = current;
      }
      return db;
    },
    config,
    root,
    sources: loadSources(root, config),
    // Writes are off unless explicitly enabled. Provenance is the substance of
    // the project, so the tool that can rewrite it does not exist by default.
    writesEnabled: process.env.ACCRETA_ALLOW_WRITES === "1",
  };
}
