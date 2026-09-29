import { readFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import {
  formatCitation,
  parseLineLocator,
  resolveInside,
  UNPINNED_REVISION,
  UnknownRevisionError,
  type LocationVerdict,
  type LocatorChange,
  type SourceAdapter,
} from "@accreta/core";

export interface GitSourceOptions {
  id: string;
  /** Working tree of the repository. */
  root: string;
  /** Provenance template, from `accreta.config.yaml`. */
  citationFormat: string;
  /**
   * Restrict the source to these repository-relative paths.
   *
   * Without it a source is the entire repository, so any commit touching
   * anything — a README, a test — reports as drift for pages whose documents
   * never moved. A drift report full of false positives is one people learn to
   * ignore, which costs more than having no report at all.
   */
  paths?: readonly string[];
}

/** Run a git command in the repository, returning stdout. */
async function git(root: string, args: string[]): Promise<string> {
  const proc = Bun.spawn(["git", ...args], {
    cwd: root,
    // accreta only reads; without this `status` rewrites .git/index and a user's commit can hit index.lock.
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new GitCommandError(args, exitCode, stderr.trim());
  }
  return stdout;
}

export class GitCommandError extends Error {
  constructor(
    readonly args: string[],
    readonly exitCode: number,
    readonly stderr: string,
  ) {
    super(`git ${args.join(" ")} failed (${exitCode}): ${stderr}`);
    this.name = "GitCommandError";
  }
}

/**
 * Is there a repository at this path?
 *
 * Exported for preflight rather than used by the adapter: an adapter that
 * checked would pay for it on every call, and the answer only matters when
 * somebody is asking whether the source is wired up correctly.
 */
export async function isWorkingTree(root: string): Promise<boolean> {
  try {
    await git(root, ["rev-parse", "--git-dir"]);
    return true;
  } catch {
    return false;
  }
}

/**
 * A git repository as a source.
 *
 * The natural implementation: a revision is a commit SHA, and what changed
 * since one is `diff --name-only`. Everything the interface needs, git already
 * answers precisely — which is what makes it the easy case, and the reason the
 * `fs` adapter is the one that proves the abstraction is not git-shaped.
 */
export class GitSource implements SourceAdapter {
  readonly id: string;
  private readonly root: string;
  private readonly citationFormat: string;
  private readonly paths: readonly string[];

  constructor(options: GitSourceOptions) {
    this.id = options.id;
    this.root = options.root;
    this.citationFormat = options.citationFormat;
    this.paths = options.paths ?? [];
  }

  /**
   * The revision of the source: the last commit that touched it.
   *
   * With `paths` set this is `rev-list -1 HEAD -- <paths>` rather than HEAD, so
   * a source's revision advances only when the source itself changes. Using
   * HEAD would drift every page in the knowledge base on every commit to the
   * repository, whatever it touched.
   */
  async revision(): Promise<string> {
    if (this.paths.length === 0) {
      return (await git(this.root, ["rev-parse", "HEAD"])).trim();
    }
    const out = (await git(this.root, ["rev-list", "-1", "HEAD", "--", ...this.paths])).trim();
    // Paths with no commits yet are legitimately empty, and HEAD is the honest
    // answer: nothing in this source has ever changed.
    return out || (await git(this.root, ["rev-parse", "HEAD"])).trim();
  }

  /**
   * `cat-file -e` is the cheap way to ask whether this repository has ever heard of the
   * revision. A shallow clone, a rewritten history or another repository's revision all say no.
   */
  async knowsRevision(revision: string): Promise<boolean> {
    try {
      await git(this.root, ["cat-file", "-e", `${revision}^{commit}`]);
      return true;
    } catch {
      return false;
    }
  }

  async changedSince(revision: string): Promise<string[]> {
    // Answering "nothing changed" for a revision this repository cannot place
    // would be a lie that drift detection cannot detect.
    if (!(await this.knowsRevision(revision))) {
      throw new UnknownRevisionError(this.id, revision);
    }

    const args = ["diff", "--name-only", revision, "HEAD"];
    if (this.paths.length > 0) args.push("--", ...this.paths);
    const out = await git(this.root, args);
    return out.split("\n").filter(Boolean).toSorted();
  }

  /**
   * What the change from `revision` to HEAD did to each cited line range, from `diff -U0`.
   * A deleted file touches everything; a locator that is not a line range cannot be judged.
   */
  async touchedSince(
    revision: string,
    path: string,
    locators: readonly string[],
  ): Promise<Map<string, LocatorChange>> {
    if (!(await this.knowsRevision(revision))) throw new UnknownRevisionError(this.id, revision);
    const diff = await git(this.root, [
      "diff",
      "-U0",
      "--no-color",
      "--no-ext-diff",
      revision,
      "HEAD",
      "--",
      path,
    ]);
    const deleted = /^\+\+\+ \/dev\/null$/m.test(diff);
    const hunks = parseHunks(diff);

    const out = new Map<string, LocatorChange>();
    for (const locator of locators) {
      const range = parseLineLocator(locator);
      if (!range) out.set(locator, { status: "unknown" });
      else if (deleted || hunks.some((hunk) => touches(hunk, range[0], range[1])))
        out.set(locator, { status: "touched" });
      else {
        const [start, end] = [shift(hunks, range[0]), shift(hunks, range[1])];
        out.set(
          locator,
          start === range[0]
            ? { status: "untouched" }
            : { status: "moved", locator: start === end ? `L${start}` : `L${start}-L${end}` },
        );
      }
    }
    return out;
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

    // Joined before the first await, so every locate issued together shares one `git status`.
    const state = this.workingState(relative(resolve(this.root), full).split(sep).join("/"));
    state.catch(() => {});

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

    // `revision()` names a commit, so a place checked on a dirty tree would be vouched for by one
    // that never held it.
    let working: WorkingState;
    try {
      working = await state;
    } catch (error) {
      const detail =
        error instanceof GitCommandError
          ? `git refused the repository: ${error.stderr}`
          : `git could not run: ${error instanceof Error ? error.message : String(error)}`;
      return { verdict: "unknown", detail };
    }
    // No path in these details: lint groups unknowns by detail and lists the paths itself.
    if (working === "changed") {
      return {
        verdict: "unknown",
        detail: "uncommitted changes: no commit holds what is on disk",
      };
    }
    if (working === "untracked") {
      return {
        verdict: "unknown",
        detail:
          "not tracked here (untracked, ignored, in a submodule, or spelled differently from the index): no commit of this repository holds it",
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

  private batch: { paths: Set<string>; states: Promise<Map<string, WorkingState>> } | undefined;
  private prefix: Promise<string> | undefined;

  /** The batch closes when it runs, so each caller's status is taken after it asked. */
  private workingState(path: string): Promise<WorkingState> {
    // The root itself is no file, and an empty pathspec would fail the whole batch.
    if (path === "") return Promise.resolve("committed");
    let batch = this.batch;
    if (!batch) {
      const paths = new Set<string>();
      const states = Promise.resolve().then(() => {
        this.batch = undefined;
        return this.statesOf([...paths]);
      });
      batch = this.batch = { paths, states };
    }
    batch.paths.add(path);
    return batch.states.then((states) => states.get(path) ?? "committed");
  }

  private async statesOf(paths: string[]): Promise<Map<string, WorkingState>> {
    this.prefix ??= git(this.root, ["rev-parse", "--show-prefix"]).then(
      (out) => out.trim(),
      (error) => {
        this.prefix = undefined;
        throw error;
      },
    );
    const prefix = await this.prefix;

    const tracked = new Set<string>();
    const changed = new Set<string>();
    for (let i = 0; i < paths.length; i += 256) {
      const chunk = ["--", ...paths.slice(i, i + 256)];
      const [files, status] = await Promise.all([
        git(this.root, ["--literal-pathspecs", "ls-files", "-z", "--full-name", ...chunk]),
        git(this.root, [
          "--literal-pathspecs",
          "status",
          "--porcelain",
          "-z",
          "--no-renames",
          "--untracked-files=no",
          ...chunk,
        ]),
      ]);
      for (const file of files.split("\0")) if (file) tracked.add(file);
      // Case-blind, so a spelling git reports differently errs to `changed`, never to `committed`.
      for (const record of status.split("\0"))
        if (record) changed.add(record.slice(3).toLowerCase());
    }

    const states = new Map<string, WorkingState>();
    for (const path of paths) {
      const full = prefix + path;
      if (!tracked.has(full)) states.set(path, "untracked");
      else if (changed.has(full.toLowerCase())) states.set(path, "changed");
    }
    return states;
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
   * whatever HEAD happens to be when the page is rendered later — that is the
   * difference between provenance and a guess.
   */
  private pinnedRevision: string | undefined;

  pinRevision(revision: string): void {
    this.pinnedRevision = revision;
  }
}

type WorkingState = "committed" | "changed" | "untracked";

interface Hunk {
  oldStart: number;
  oldLength: number;
  newLength: number;
}

function parseHunks(diff: string): Hunk[] {
  return [...diff.matchAll(/^@@ -(\d+)(?:,(\d+))? \+\d+(?:,(\d+))? @@/gm)].map((m) => ({
    oldStart: Number(m[1]),
    oldLength: m[2] === undefined ? 1 : Number(m[2]),
    newLength: m[3] === undefined ? 1 : Number(m[3]),
  }));
}

/**
 * Whether a hunk changes any line of `start..end`. A pure insertion sits after `oldStart`, so it
 * touches a range only when it lands inside it: the rule behind 0 wrong clears in 60 (#108).
 */
function touches(hunk: Hunk, start: number, end: number): boolean {
  return hunk.oldLength === 0
    ? start <= hunk.oldStart && hunk.oldStart < end
    : hunk.oldStart <= end && hunk.oldStart + hunk.oldLength - 1 >= start;
}

/** Where an untouched line is now: every hunk wholly above it shifts it by its net growth. */
function shift(hunks: Hunk[], line: number): number {
  let offset = 0;
  for (const hunk of hunks) {
    const last = hunk.oldLength === 0 ? hunk.oldStart : hunk.oldStart + hunk.oldLength - 1;
    if (last < line) offset += hunk.newLength - hunk.oldLength;
  }
  return line + offset;
}
