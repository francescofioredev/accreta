import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  openIndex,
  parseConfig,
  sqliteSupport,
  StaleIndexError,
  UnsupportedRuntimeError,
  type Database,
} from "@accreta/core";
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
 * The index's identity, or null if it cannot be stat'd. A rebuild is never observable as an
 * absence — rename(2) replaces the path atomically — so a missing file is gone, not mid-swap.
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
 * Assemble what the tools need. The index is opened read-only: the write tool edits markdown
 * and asks for a reindex, since an index updated in place would drift from the pages it derives from.
 */
export function createContext(cwd: string = process.cwd()): ToolContext {
  // The runtime, unlike the index, cannot be mended by a reindex: refuse to start.
  if (sqliteSupport() !== null) throw new UnsupportedRuntimeError();
  const root = findRoot(cwd);
  const config = parseConfig(readFileSync(join(root, CONFIG_FILENAME), "utf-8"));

  const indexPath = process.env.ACCRETA_INDEX_PATH
    ? resolve(process.env.ACCRETA_INDEX_PATH)
    : join(root, ".accreta", "index.sqlite");

  interface Handle {
    db: Database;
    inode: string | null;
    pins: number;
  }
  // Opened on first use, so an index this accreta cannot read fails a tool call the agent sees,
  // not the server start it never does; every later call tries again, so a reindex mends it.
  let handle: Handle | null = null;
  const open = (): Database => {
    try {
      return openIndex(indexPath, { readonly: true });
    } catch (error) {
      if (error instanceof StaleIndexError || error instanceof UnsupportedRuntimeError) throw error;
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Cannot open the index at ${indexPath}: ${reason}; run \`accreta reindex\` to rebuild it.`,
        { cause: error },
      );
    }
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
    // Stat before opening: a swap in between then costs one more reopen, never a stale handle.
    const inode = inodeOf(indexPath);
    if (handle === null) {
      if (inode === null) {
        throw new Error(`No index at ${indexPath}. Run \`accreta reindex\` first.`);
      }
      handle = { db: open(), inode, pins: 0 };
    } else if (inode !== null && inode !== handle.inode) {
      // Open before closing, so a failed reopen leaves a working context rather than a dead one.
      const reopened = open();
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
