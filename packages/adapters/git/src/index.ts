import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { constants } from "node:os";
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
   * Paths relative to `root`, not the repository top, that bound the source. Without them any
   * commit drifts pages whose documents never moved, and a noisy report is one people ignore.
   */
  paths?: readonly string[];
}

/** Run a git command in the repository, returning stdout. */
function git(root: string, args: string[]): Promise<string> {
  // accreta only reads; without this `status` rewrites .git/index and a user's commit can hit index.lock.
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_OPTIONAL_LOCKS: "0" };
  // GIT_DIFF_OPTS would override the -U0 that hunk parsing depends on.
  delete env.GIT_DIFF_OPTS;

  return new Promise((resolveOutput, reject) => {
    // Streamed, not execFile: its maxBuffer turns a large diff into an error.
    const child = spawn("git", args, { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (code === 0) return resolveOutput(Buffer.concat(stdout).toString("utf-8"));
      const exitCode = code ?? 128 + (signal ? constants.signals[signal] : 0);
      reject(new GitCommandError(args, exitCode, Buffer.concat(stderr).toString("utf-8").trim()));
    });
  });
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
   * The last commit that touched the source: `rev-list -1 HEAD -- <scope>` when `paths` or a root
   * below the top level bounds it, since HEAD would drift every page on every commit anywhere.
   */
  async revision(): Promise<string> {
    // At the top level `-- .` would skip an empty or TREESAME merge HEAD, so the revision stays HEAD.
    const scope =
      this.paths.length > 0 ? this.paths : (await this.showPrefix()) === "" ? [] : ["."];
    if (scope.length === 0) {
      return (await git(this.root, ["rev-parse", "HEAD"])).trim();
    }
    const out = (await git(this.root, ["rev-list", "-1", "HEAD", "--", ...scope])).trim();
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

    // Citations name a renamed file's old path; -z stops git quoting a non-ASCII one.
    // --relative: citations name paths from the root, not the repository top.
    const args = ["diff", "--name-only", "-z", "--no-renames", "--relative", revision, "HEAD"];
    if (this.paths.length > 0) args.push("--", ...this.paths);
    const out = await git(this.root, args);
    return out.split("\0").filter(Boolean).toSorted();
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
    const out = new Map<string, LocatorChange>();
    const ranges = locators.map((locator) => [locator, parseLineLocator(locator)] as const);
    // Only a line range is judged from the diff, and a large file's diff is expensive.
    if (ranges.every(([, range]) => !range)) {
      for (const locator of locators) out.set(locator, { status: "unknown" });
      return out;
    }

    const diff = await git(this.root, [
      "--literal-pathspecs",
      "diff",
      "-U0",
      // The hunks must count the lines on disk, whatever the user's diff config says.
      "--inter-hunk-context=0",
      "--diff-algorithm=myers",
      "--indent-heuristic",
      "--no-renames",
      "--no-color",
      "--no-ext-diff",
      "--no-textconv",
      // A `-diff` attribute or a NUL byte would print "Binary files differ" and no hunks.
      "--text",
      revision,
      "HEAD",
      "--",
      path,
    ]);
    const deleted = /^\+\+\+ \/dev\/null$/m.test(diff);
    // A filter or encoding means the blob's lines are not the lines on disk that `locate` counts.
    const unreadable = diff !== "" && !deleted && (await this.convertedOnCheckout(path));
    const hunks = parseHunks(diff);

    for (const [locator, range] of ranges) {
      if (!range || unreadable) out.set(locator, { status: "unknown" });
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

  private async convertedOnCheckout(path: string): Promise<boolean> {
    const out = await git(this.root, [
      "check-attr",
      "-z",
      "filter",
      "working-tree-encoding",
      "--",
      path,
    ]);
    const fields = out.split("\0");
    for (let i = 2; i < fields.length; i += 3) {
      if (fields[i] !== "unspecified" && fields[i] !== "unset") return true;
    }
    return false;
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

  /** Where the root sits below the repository top, with a trailing slash; "" at the top. */
  private showPrefix(): Promise<string> {
    this.prefix ??= git(this.root, ["rev-parse", "--show-prefix"]).then(
      (out) => out.trim(),
      (error) => {
        this.prefix = undefined;
        throw error;
      },
    );
    return this.prefix;
  }

  private async statesOf(paths: string[]): Promise<Map<string, WorkingState>> {
    const prefix = await this.showPrefix();

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
