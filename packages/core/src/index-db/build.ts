import { readdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { AccretaConfig } from "../config.ts";
import { extractLinks, tryResolveWikilink } from "../links.ts";
import { parsePage } from "../page.ts";
import { openIndex, sealForReading, type Database } from "./db.ts";

export interface BuildResult {
  pages: number;
  links: number;
  brokenLinks: number;
  ms: number;
}

export interface BuildOptions {
  /** Root the knowledge base is resolved against and paths are recorded relative to. */
  root: string;
  config: AccretaConfig;
  /** Where to write the index. */
  indexPath: string;
}

function* walkMarkdown(dir: string): Generator<string> {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    // A knowledge base that does not exist yet is an empty one, not a crash:
    // `init` writes the config before there is anything to index.
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      yield* walkMarkdown(full);
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      yield full;
    }
  }
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Flatten declared aliases into one searchable string.
 *
 * Which field holds them is not configurable: `aliases` is part of the page
 * schema rather than the domain vocabulary, in the same way `type` is.
 */
function aliasesOf(frontmatter: Record<string, unknown>): string {
  const value = frontmatter.aliases;
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.filter((a): a is string => typeof a === "string").join(" ");
}

/** Record paths with `/` regardless of platform: they are identifiers, not filesystem locations. */
function toPosix(path: string): string {
  return sep === "/" ? path : path.split(sep).join("/");
}

/**
 * Rebuild the whole index.
 *
 * Not incremental by design: a DELETE and reinsert of every page inside one
 * transaction. At the corpus sizes this targets, delta tracking buys
 * milliseconds and costs a class of staleness bugs where the index disagrees
 * with the knowledge base and nothing notices.
 */
export function buildIndex(options: BuildOptions): BuildResult {
  const started = performance.now();
  const { root, config, indexPath } = options;

  // Build beside the live index rather than into it, then move the finished file
  // into place. rename(2) is atomic within a filesystem, so no reader ever opens
  // a half-rebuilt index: at any instant the path names the whole old database
  // or the whole new one.
  //
  // What this does *not* buy is a defined outcome for a connection that outlives
  // the swap, and the difference is platform-dependent: on Linux the unlinked
  // inode stays alive behind the open descriptor and the stale handle keeps
  // serving the old rows, while on macOS SQLite revalidates the file and fails
  // that connection with SQLITE_IOERR. Both were observed in CI against the
  // same code. A long-lived reader must therefore reopen after a rebuild rather
  // than assume either behaviour.
  //
  // The staging file sits beside the target, not in the system temp directory:
  // rename(2) across filesystems fails with EXDEV, and /tmp is very often a
  // different filesystem.
  const stagingPath = `${indexPath}.building`;
  removeIndexFiles(stagingPath);

  const db = openIndex(stagingPath);
  let result: BuildResult;
  try {
    result = runBuild(db, root, config, started);
    sealForReading(db);
  } finally {
    db.close();
  }

  // Rename *over* the target rather than unlinking it first. rename(2) replaces
  // the destination atomically, and unlinking beforehand is what breaks the
  // guarantee: a reader holding the old file gets "disk I/O error" the moment
  // its inode is dropped, instead of quietly finishing against the old data.
  renameSync(stagingPath, indexPath);

  // The staging sidecars are not covered by the rename; the sealed database
  // needs none of them.
  for (const suffix of ["-wal", "-shm"]) {
    rmSync(`${stagingPath}${suffix}`, { force: true });
  }

  return { ...result, ms: performance.now() - started };
}

/** Remove a stale staging index and any sidecars left beside it. */
function removeIndexFiles(path: string): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    rmSync(`${path}${suffix}`, { force: true });
  }
}

function runBuild(db: Database, root: string, config: AccretaConfig, started: number): BuildResult {
  const insertPage = db.prepare(`
    INSERT INTO pages (
      path, type, title, source, canonical_source,
      last_verified_revision, last_ingest_revision, last_ingest_at,
      frontmatter_json, body, mtime
    ) VALUES (
      $path, $type, $title, $source, $canonical_source,
      $last_verified_revision, $last_ingest_revision, $last_ingest_at,
      $frontmatter_json, $body, $mtime
    )
  `);
  const insertFts = db.prepare(`
    INSERT INTO pages_fts (title, aliases, body, path, type, source)
    VALUES ($title, $aliases, $body, $path, $type, $source)
  `);
  const insertLink = db.prepare(
    `INSERT OR IGNORE INTO links (src_path, dst_path, kind) VALUES ($src, $dst, $kind)`,
  );
  const insertBroken = db.prepare(
    `INSERT OR IGNORE INTO broken_links (src_path, target, kind, reason)
     VALUES ($src, $target, $kind, $reason)`,
  );
  const upsertMeta = db.prepare(
    `INSERT INTO meta (key, value) VALUES ($key, $value)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  );

  let pages = 0;
  let links = 0;
  let brokenLinks = 0;
  let maxMtime = 0;

  const knowledgeDir = join(root, config.knowledgeBase);

  db.exec("BEGIN");
  try {
    db.exec("DELETE FROM pages");
    db.exec("DELETE FROM pages_fts");
    db.exec("DELETE FROM links");
    db.exec("DELETE FROM broken_links");

    for (const absolute of walkMarkdown(knowledgeDir)) {
      const path = toPosix(relative(root, absolute));
      const raw = readFileSync(absolute, "utf-8");
      const mtime = statSync(absolute).mtimeMs;
      if (mtime > maxMtime) maxMtime = mtime;

      const fallbackTitle = path.replace(/\.md$/, "");
      const { frontmatter, body, title } = parsePage(raw, fallbackTitle);

      // An unrecognised type is recorded as-is rather than coerced: the page
      // exists and `lint` should be able to name what is wrong with it.
      const type = asString(frontmatter.type) ?? "unknown";
      const source = asString(frontmatter.source);

      insertPage.run({
        $path: path,
        $type: type,
        $title: title,
        $source: source,
        $canonical_source: asString(frontmatter.canonical_source),
        $last_verified_revision: asString(frontmatter.last_verified_revision),
        $last_ingest_revision: asString(frontmatter.last_ingest_revision),
        $last_ingest_at: asString(frontmatter.last_ingest_at),
        $frontmatter_json: JSON.stringify(frontmatter),
        $body: body,
        $mtime: Math.floor(mtime),
      });

      insertFts.run({
        $title: title,
        $aliases: aliasesOf(frontmatter),
        $body: body,
        $path: path,
        $type: type,
        $source: source ?? "",
      });

      for (const link of extractLinks(frontmatter, body, config)) {
        const resolved = tryResolveWikilink(link.target, config);
        if (resolved.ok) {
          insertLink.run({ $src: path, $dst: resolved.path, $kind: link.kind });
          links++;
        } else {
          // Kept, not dropped. Every silent-edge-loss defect in this phase came
          // from a link disappearing with nothing to show for it.
          insertBroken.run({
            $src: path,
            $target: resolved.target,
            $kind: link.kind,
            $reason: resolved.reason,
          });
          brokenLinks++;
        }
      }

      pages++;
    }

    upsertMeta.run({ $key: "last_reindex_at", $value: new Date().toISOString() });
    upsertMeta.run({ $key: "page_count", $value: String(pages) });
    upsertMeta.run({ $key: "max_mtime", $value: String(Math.floor(maxMtime)) });
    upsertMeta.run({ $key: "knowledge_base", $value: config.knowledgeBase });

    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  return { pages, links, brokenLinks, ms: performance.now() - started };
}
