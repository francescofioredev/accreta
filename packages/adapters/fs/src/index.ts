import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  futimesSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, dirname, join, relative, sep } from "node:path";
import {
  formatCitation,
  parseLineLocator,
  resolveInside,
  UNPINNED_REVISION,
  UnknownRevisionError,
  type LocationVerdict,
  type SourceAdapter,
} from "@accreta/core";

export interface FsSourceOptions {
  id: string;
  /** Directory the source is rooted at. Paths are reported relative to it. */
  root: string;
  /** Provenance template, from `accreta.config.yaml`. */
  citationFormat: string;
  /** File extensions to consider. Empty means every file. */
  extensions?: readonly string[];
  /** Local state directory, beside the index. Without it snapshots last as long as this instance. */
  stateDir?: string;
  /** Overrides SNAPSHOT_BUDGET_BYTES; for tests. */
  snapshotBudgetBytes?: number;
  /** Overrides SNAPSHOT_MAX_BYTES; for tests. */
  snapshotMaxBytes?: number;
}

type Listing = readonly (readonly [path: string, mtimeMs: number])[];

/** Per source, for snapshots the last run neither wrote nor read. The rule is in ADR-0002. */
export const SNAPSHOT_BUDGET_BYTES = 64 * 1024 * 1024;
/** One snapshot, about 1.4M files at 35–59 bytes each; a larger one is never written or read. */
export const SNAPSHOT_MAX_BYTES = 64 * 1024 * 1024;

const SNAPSHOTS = "fs-snapshots";
const MARKER = ".last-run";
const PREVIOUS_MARKER = ".prev-run";
const SNAPSHOT_FORMAT = 1;
const REVISION = /^[0-9a-f]{12}$/;
const SNAPSHOT_FILE = /^[0-9a-f]{12}\.json(\.\d+\.[0-9a-f-]{36}\.tmp)?$/;
const NOFOLLOW = (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
const READ_FLAGS = constants.O_RDONLY | NOFOLLOW;
const MARK_FLAGS = constants.O_WRONLY | constants.O_CREAT | NOFOLLOW;
const WRITE_FLAGS = MARK_FLAGS | constants.O_EXCL;
// Windows has no getuid and no meaningful mode bits, so ownership is not checked there.
const UID = process.getuid?.();

/** Hashed so no id, however long or odd, fails as a path component or collides by case. */
export function snapshotDirFor(stateDir: string, id: string): string {
  return join(stateDir, SNAPSHOTS, createHash("sha256").update(id).digest("hex").slice(0, 16));
}

function hashOf(listing: Listing): string {
  const hash = createHash("sha256");
  for (const [path, mtimeMs] of listing) hash.update(`${path}\0${mtimeMs}\0`);
  return hash.digest("hex").slice(0, 12);
}

/** Only what scan() produces: sorted, unique, NUL-free paths, which keeps hashOf unambiguous. */
function isListing(value: unknown): value is Listing {
  if (!Array.isArray(value)) return false;
  let previous: string | undefined;
  for (const e of value) {
    if (!Array.isArray(e) || e.length !== 2) return false;
    const [path, mtimeMs] = e as unknown[];
    if (typeof path !== "string" || typeof mtimeMs !== "number" || path.includes("\0")) {
      return false;
    }
    if (previous !== undefined && !(previous < path)) return false;
    previous = path;
  }
  return true;
}

function serialize(revision: string, listing: Listing): string {
  return JSON.stringify({ format: SNAPSHOT_FORMAT, revision, entries: listing });
}

function mkdirIfMissing(path: string): void {
  try {
    mkdirSync(path, { mode: 0o700 });
  } catch {
    // Exists, as a directory or not; the lstat that follows decides.
  }
}

function removeQuietly(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // Gone already, or not ours to remove; a failed prune must not fail drift.
  }
}

type DirCheck = { dir: string } | { problem: string } | { missing: string };

/**
 * Group-writable is trusted, as umask 002 means; anyone-writable needs the sticky bit, or
 * others could rename our directories, and a sticky dir must be ours or root's, as /tmp is.
 */
function stateDirProblem(dir: string, mode: number, uid: number): string | undefined {
  const sticky = (mode & 0o1000) !== 0;
  if ((mode & 0o002) !== 0 && !sticky) return `${dir} is world-writable without the sticky bit`;
  if (sticky && uid !== UID && uid !== 0) return `${dir} is sticky but owned by another user`;
  return undefined;
}

/**
 * The snapshot directory, only if every step from the state directory down is a real directory,
 * and the two below it, which accreta creates, are this user's and writable by nobody else.
 *
 * Git stores symlinks, so a committed `.accreta` or `fs-snapshots/<hash>` link would
 * otherwise aim the writes and the prune at any directory on a contributor's machine.
 */
function snapshotDir(stateDir: string, id: string, create: boolean): DirCheck {
  const dir = snapshotDirFor(stateDir, id);
  try {
    if (create) mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    for (const step of [stateDir, dirname(dir), dir]) {
      if (create && step !== stateDir) mkdirIfMissing(step);
      let stat;
      try {
        stat = lstatSync(step);
      } catch {
        return { missing: step };
      }
      if (stat.isSymbolicLink()) return { problem: `${step} is a symlink` };
      if (!stat.isDirectory()) return { problem: `${step} is not a directory` };
      if (UID === undefined) continue;
      if (step === stateDir) {
        const problem = stateDirProblem(step, stat.mode, stat.uid);
        if (problem) return { problem };
        continue;
      }
      if (stat.uid !== UID) return { problem: `${step} is not owned by this user` };
      if ((stat.mode & 0o022) !== 0) return { problem: `${step} is group- or world-writable` };
    }
    if (realpathSync(dir) !== join(realpathSync(stateDir), SNAPSHOTS, basename(dir))) {
      return { problem: `${dir} resolves somewhere else` };
    }
    return { dir };
  } catch (error) {
    return { problem: error instanceof Error ? error.message : String(error) };
  }
}

/** Start a run: shift the markers a generation and return what the prune must protect from. */
function markRun(dir: string): number | undefined {
  const since = protectedSince(dir);
  const last = markerTime(join(dir, MARKER));
  if (last !== undefined) stamp(join(dir, PREVIOUS_MARKER), new Date(last));
  stamp(join(dir, MARKER), new Date());
  return since;
}

/** Two generations back, so one run that reads nothing, overlapping or aborted, cannot expose what pages cite. */
function protectedSince(dir: string): number | undefined {
  const last = markerTime(join(dir, MARKER));
  if (last === undefined) return undefined;
  const previous = markerTime(join(dir, PREVIOUS_MARKER));
  return previous === undefined ? last : Math.min(last, previous);
}

function markerTime(path: string): number | undefined {
  try {
    const stat = lstatSync(path);
    return stat.isFile() ? stat.mtimeMs : undefined;
  } catch {
    return undefined;
  }
}

function stamp(path: string, when: Date): void {
  let fd: number | undefined;
  try {
    fd = openSync(path, MARK_FLAGS, 0o600);
    futimesSync(fd, when, when);
  } catch {
    // Without a marker the next run keeps everything, which is the safe side.
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

interface SnapshotFile {
  path: string;
  mtimeMs: number;
  size: number;
}

/** Regular files named as this adapter names them; nothing else in the directory is ours. */
function snapshotFiles(dir: string): SnapshotFile[] {
  try {
    return readdirSync(dir)
      .filter((name) => SNAPSHOT_FILE.test(name))
      .flatMap((name) => {
        const path = join(dir, name);
        try {
          const stat = lstatSync(path);
          return stat.isFile() ? [{ path, mtimeMs: stat.mtimeMs, size: stat.size }] : [];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

/**
 * Evict, oldest first, only snapshots the last two runs neither wrote nor read, until under budget.
 *
 * Drift reads every cited revision, so that set holds what pages cite now; it is kept even
 * when it alone exceeds the budget. With no previous run on record, nothing goes.
 */
function prune(dir: string, since: number | undefined, budget: number): void {
  if (since === undefined) return;
  const files = snapshotFiles(dir);
  let total = files.reduce((sum, file) => sum + file.size, 0);
  const evictable = files
    .filter((file) => file.mtimeMs < since)
    .toSorted((a, b) => a.mtimeMs - b.mtimeMs);
  for (const file of evictable) {
    if (total <= budget) break;
    removeQuietly(file.path);
    total -= file.size;
  }
}

function scanTree(root: string, extensions: readonly string[]): [string, number][] {
  const out: [string, number][] = [];
  walk(root, root, extensions, out);
  out.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return out;
}

function walk(
  root: string,
  dir: string,
  extensions: readonly string[],
  into: [string, number][],
): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      walk(root, full, extensions, into);
      continue;
    }
    if (!entry.isFile()) continue;
    if (extensions.length > 0 && !extensions.some((e) => entry.name.endsWith(e))) continue;
    const path = relative(root, full);
    into.push([sep === "/" ? path : path.split(sep).join("/"), statSync(full).mtimeMs]);
  }
}

const MiB = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MiB`;

export interface SnapshotHealth {
  /** False means a new process cannot place this source's revisions. */
  persists: boolean;
  detail?: string;
}

/** What `doctor` reports: why snapshots cannot persist, or that the kept set is over budget. */
export function snapshotHealth(options: FsSourceOptions): SnapshotHealth {
  if (!options.stateDir) return { persists: false, detail: "no state directory was given" };

  const check = snapshotDir(options.stateDir, options.id, false);
  if ("problem" in check) return { persists: false, detail: check.problem };

  const max = options.snapshotMaxBytes ?? SNAPSHOT_MAX_BYTES;
  const listing = scanTree(options.root, options.extensions ?? []);
  const size = Buffer.byteLength(serialize(hashOf(listing), listing));
  if (size > max) {
    return {
      persists: false,
      detail: `a snapshot would be ${MiB(size)}, over the ${MiB(max)} cap`,
    };
  }

  if ("missing" in check) return { persists: true };
  const since = protectedSince(check.dir);
  if (since === undefined) return { persists: true };
  const budget = options.snapshotBudgetBytes ?? SNAPSHOT_BUDGET_BYTES;
  const used = snapshotFiles(check.dir).filter((file) => file.mtimeMs >= since);
  const usedBytes = used.reduce((sum, file) => sum + file.size, 0);
  return usedBytes > budget
    ? {
        persists: true,
        detail: `the ${used.length} snapshots the last two runs used take ${MiB(usedBytes)}, over the ${MiB(budget)} budget; all are kept`,
      }
    : { persists: true };
}

/**
 * A directory of documents as a source.
 *
 * There is no version control here, so a revision is a hash over the paths and
 * modification times of everything in the tree: it changes exactly when the
 * tree changes, which is all `revision()` promises. It is deliberately not a
 * hash of file *contents* — that would make `revision()` cost a full read of
 * the corpus on every drift check, and mtime is what a filesystem is willing to
 * answer cheaply.
 *
 * The trade-off is honest rather than hidden: a change that preserves mtime is
 * invisible to this adapter. A source that needs content-level certainty should
 * be backed by something that versions its contents, which is what the git
 * adapter is for.
 */
export class FsSource implements SourceAdapter {
  readonly id: string;
  private readonly root: string;
  private readonly citationFormat: string;
  private readonly extensions: readonly string[];
  private readonly stateDir: string | undefined;
  private readonly budget: number;
  private readonly maxBytes: number;

  /**
   * Snapshots taken by `revision()`, keyed by the revision they produced.
   *
   * `changedSince()` needs the *old* listing to diff against, and a hash cannot
   * be inverted. Without this the adapter could only ever answer "everything
   * changed". With a `stateDir` each one is also written to disk for the
   * next process; a revision found in neither place is genuinely unknown, and
   * saying so is the point of UnknownRevisionError.
   */
  private readonly snapshots = new Map<string, Map<string, number>>();

  constructor(options: FsSourceOptions) {
    this.id = options.id;
    this.root = options.root;
    this.citationFormat = options.citationFormat;
    this.extensions = options.extensions ?? [];
    this.stateDir = options.stateDir;
    this.budget = options.snapshotBudgetBytes ?? SNAPSHOT_BUDGET_BYTES;
    this.maxBytes = options.snapshotMaxBytes ?? SNAPSHOT_MAX_BYTES;
  }

  async revision(): Promise<string> {
    const listing = this.scan();
    const revision = hashOf(listing);
    this.snapshots.set(revision, new Map(listing));
    this.save(revision, listing);
    return revision;
  }

  async changedSince(revision: string): Promise<string[]> {
    let previous = this.snapshots.get(revision);
    // A hit from memory is still a use: the file must stay protected for the next process.
    if (previous) this.touch(revision);
    else previous = this.load(revision);
    if (!previous) {
      // "I cannot tell" is not "nothing changed". Conflating them would let
      // drift detection report pages as verified against a revision it has no
      // way to compare with.
      throw new UnknownRevisionError(this.id, revision);
    }

    const current = new Map(this.scan());
    const changed = new Set<string>();

    for (const [path, mtime] of current) {
      if (previous.get(path) !== mtime) changed.add(path);
    }
    for (const path of previous.keys()) {
      if (!current.has(path)) changed.add(path);
    }

    return [...changed].toSorted();
  }

  /**
   * Whether a citation names something that is really in this source.
   *
   * A path that climbs out of the root is refused rather than reported as an
   * error: it names nothing this source can offer, and reading it to find out
   * is exactly what `resolveInside` exists to prevent.
   */
  async locate(path: string, locator?: string): Promise<LocationVerdict> {
    let full: string;
    try {
      full = resolveInside(this.root, path);
    } catch {
      return {
        verdict: "missing",
        part: "path",
        detail: `${path} resolves outside source "${this.id}"`,
      };
    }

    let text: string;
    try {
      text = await readFile(full, "utf-8");
    } catch {
      return {
        verdict: "missing",
        part: "path",
        detail: `${path} does not exist in source "${this.id}"`,
      };
    }

    if (locator === undefined) return { verdict: "found" };

    const range = parseLineLocator(locator);
    if (!range) {
      return {
        verdict: "missing",
        part: "locator",
        detail: `"${locator}" is not a line range, and ${path} is addressed by line`,
      };
    }

    const lines = text.split("\n").length;
    if (range[1] > lines) {
      return {
        verdict: "missing",
        part: "locator",
        detail: `cites L${range[0]}-L${range[1]} but ${path} has ${lines} line(s)`,
      };
    }
    return { verdict: "found" };
  }

  citation(path: string, locator?: string): string {
    return formatCitation(this.citationFormat, {
      source: this.id,
      rev: this.pinnedRevision ?? UNPINNED_REVISION,
      path,
      locator,
    });
  }

  /**
   * Revision used when rendering citations.
   *
   * A citation must name the revision the claim was verified against, not
   * whatever the tree hashes to when the page is rendered later.
   */
  private pinnedRevision: string | undefined;

  pinRevision(revision: string): void {
    this.pinnedRevision = revision;
  }

  /**
   * Best effort: a snapshot that cannot be written leaves the next process at
   * "cannot place", which is honest, rather than failing the drift check.
   */
  private save(revision: string, listing: Listing): void {
    if (!this.stateDir) return;
    const body = serialize(revision, listing);
    // Over the read cap it could never be loaded; doctor says why.
    if (Buffer.byteLength(body) > this.maxBytes) return;
    const check = snapshotDir(this.stateDir, this.id, true);
    if (!("dir" in check)) return;
    const { dir } = check;
    const target = join(dir, `${revision}.json`);
    // Unique per writer, then rename(2): two sessions writing one revision each land a whole file.
    const staging = `${target}.${process.pid}.${randomUUID()}.tmp`;
    try {
      writeFileSync(join(dir, ".gitignore"), "*\n", { flag: "wx", mode: 0o600 });
    } catch {
      // Already there.
    }
    const since = markRun(dir);
    let fd: number | undefined;
    try {
      fd = openSync(staging, WRITE_FLAGS, 0o600);
      writeFileSync(fd, body);
      // Stamped from the markers' clock: Linux dates writes coarsely, up to a tick before them.
      const now = new Date();
      futimesSync(fd, now, now);
      closeSync(fd);
      fd = undefined;
      renameSync(staging, target);
    } catch {
      if (fd !== undefined) closeSync(fd);
      removeQuietly(staging);
      return;
    }
    prune(dir, since, this.budget);
  }

  /** The directory holding `revision`'s snapshot, if it is safe to open. */
  private fileFor(revision: string): string | undefined {
    // The revision comes from page frontmatter, so it never reaches a path unchecked.
    if (!this.stateDir || !REVISION.test(revision)) return undefined;
    const check = snapshotDir(this.stateDir, this.id, false);
    return "dir" in check ? join(check.dir, `${revision}.json`) : undefined;
  }

  private touch(revision: string): void {
    const file = this.fileFor(revision);
    if (!file) return;
    let fd: number | undefined;
    try {
      fd = openSync(file, READ_FLAGS);
      if (fstatSync(fd).isFile()) {
        const now = new Date();
        futimesSync(fd, now, now);
      }
    } catch {
      // Missing or not ours: the listing in memory is still whole.
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }

  /**
   * A snapshot another process wrote, if it is intact.
   *
   * The revision is the hash of the listing, so the file is checked against its
   * own name: truncated or hand-edited, it fails and the revision stays unknown
   * rather than diffing against the wrong listing.
   */
  private load(revision: string): Map<string, number> | undefined {
    const file = this.fileFor(revision);
    if (!file) return undefined;

    let fd: number | undefined;
    try {
      // No following links and no blocking: a FIFO or a link to /dev/zero must not hang drift.
      fd = openSync(file, READ_FLAGS);
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size > this.maxBytes) return undefined;
      const buffer = Buffer.alloc(stat.size);
      let read = 0;
      while (read < stat.size) {
        const n = readSync(fd, buffer, read, stat.size - read, read);
        if (n === 0) break;
        read += n;
      }

      const snapshot = (JSON.parse(buffer.toString("utf-8", 0, read)) ?? {}) as {
        format?: unknown;
        revision?: unknown;
        entries?: unknown;
      };
      if (
        snapshot.format !== SNAPSHOT_FORMAT ||
        snapshot.revision !== revision ||
        !isListing(snapshot.entries) ||
        hashOf(snapshot.entries) !== revision
      ) {
        return undefined;
      }

      try {
        // A read is a use, so revisions pages still cite stay clear of the prune.
        const now = new Date();
        futimesSync(fd, now, now);
      } catch {
        // The listing in hand is whole either way.
      }
      const listing = new Map(snapshot.entries);
      this.snapshots.set(revision, listing);
      return listing;
    } catch {
      return undefined;
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }

  private scan(): [string, number][] {
    return scanTree(this.root, this.extensions);
  }
}
