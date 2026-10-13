import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { openIndex, parseConfig, type Database } from "@accreta/core";
import { loadSources, stateDirFor } from "@accreta/adapters";
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

  interface Handle {
    db: Database;
    inode: string | null;
    pins: number;
  }
  let handle: Handle = {
    db: openIndex(indexPath, { readonly: true }),
    inode: inodeOf(indexPath),
    pins: 0,
  };
  const loaded = loadSources({
    root,
    citationFormat: config.provenanceFormat,
    stateDir: stateDirFor(root, indexPath),
  });

  // A reindex replaces this file by rename(2). Apple's system SQLite then fails the old
  // connection with SQLITE_IOERR; Linux and Node's bundled SQLite silently serve pre-rebuild
  // rows off the unlinked inode, the worse half. So a long-lived reader reopens (ADR-0010),
  // and asks the filesystem, since a failing or stale connection cannot say it is stale.
  const refresh = (): Handle => {
    const inode = inodeOf(indexPath);
    if (inode !== null && inode !== handle.inode) {
      // Open before closing, so a failed reopen leaves a working context rather than a dead one.
      const reopened = openIndex(indexPath, { readonly: true });
      // A call that pinned the old handle closes it on release; closing it now throws under it.
      if (handle.pins === 0) handle.db.close();
      handle = { db: reopened, inode, pins: 0 };
    }
    return handle;
  };

  return {
    get db() {
      return refresh().db;
    },
    pin() {
      const pinned = refresh();
      pinned.pins++;
      let released = false;
      return {
        db: pinned.db,
        release() {
          if (released) return;
          released = true;
          pinned.pins--;
          if (pinned.pins === 0 && pinned !== handle) pinned.db.close();
        },
        replaced: () => {
          const now = inodeOf(indexPath);
          return now !== null && now !== pinned.inode;
        },
      };
    },
    config,
    root,
    sources: loaded.sources,
    unloadedSources: loaded.unloaded,
    // Writes are off unless explicitly enabled. Provenance is the substance of
    // the project, so the tool that can rewrite it does not exist by default.
    writesEnabled: process.env.ACCRETA_ALLOW_WRITES === "1",
  };
}
