import { spawn, spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { constants } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  countLines,
  formatCitation,
  parseLineLocator,
  resolveCitedFile,
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

function gitEnv(): NodeJS.ProcessEnv {
  // accreta only reads; without this `status` rewrites .git/index and a user's commit can hit index.lock.
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_OPTIONAL_LOCKS: "0" };
  // GIT_DIFF_OPTS would override the -U0 that hunk parsing depends on.
  delete env.GIT_DIFF_OPTS;
  return env;
}

/** Run a git command in the repository, returning stdout. */
function git(root: string, args: string[]): Promise<string> {
  const env = gitEnv();

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

function gitSync(root: string, args: string[], stdout: "pipe" | "ignore" = "pipe") {
  const run = spawnSync("git", args, {
    cwd: root,
    env: gitEnv(),
    stdio: ["ignore", stdout, "ignore"],
  });
  return { status: run.status, out: run.stdout?.toString("utf-8") ?? "" };
}

/**
 * Why `paths` would leave drift silent, or undefined: an entry that no tracked file matches and no
 * commit ever touched, usually one written from the repository top. Synchronous, so the
 * constructor can throw it and `loadSources` report it.
 */
export function unmatchedPaths(root: string, paths: readonly string[]): string | undefined {
  if (paths.length === 0) return undefined;
  // git attributes the pathspecs itself, so a symlinked root or a dead glob is judged as drift sees it.
  const matches = (entries: readonly string[]) =>
    gitSync(root, ["ls-files", "--error-unmatch", "--", ...entries], "ignore").status;
  // 128: a root git cannot read fails every later call, with git's own reason.
  if (matches(paths) !== 1) return undefined;
  // A deleted entry once matched, and drift must still report the deletion. A shallow clone cannot
  // see past its boundary, so there an entry deleted before it is refused.
  const dead = paths.filter(
    (entry) =>
      matches([entry]) === 1 && gitSync(root, ["rev-list", "-1", "HEAD", "--", entry]).out === "",
  );
  if (dead.length === 0) return undefined;

  const prefix = gitSync(root, ["rev-parse", "--show-prefix"]).out.trim();
  const named = dead.map((entry) => {
    if (entry.startsWith(":")) return `"${entry}"`;
    const scope = scopeOf(root, entry);
    const submodule = submoduleAbove(root, scope);
    if (submodule)
      return `"${entry}" (inside submodule "${submodule}", which needs its own source)`;
    const fix =
      prefix === ""
        ? undefined
        : scope === prefix.slice(0, -1)
          ? "."
          : scope.startsWith(prefix)
            ? scope.slice(prefix.length)
            : undefined;
    return fix !== undefined && matches([fix]) === 0
      ? `"${entry}" (did you mean "${fix}"?)`
      : `"${entry}"`;
  });
  const one = named.length === 1;
  return (
    `${one ? "`paths` entry" : "`paths` entries"} ${named.join(", ")} ` +
    `${one ? "matches" : "match"} no tracked file. ` +
    `\`paths\` are relative to \`root\`, not to the repository top.`
  );
}

/** The gitlink above `scope`, if any: the superproject lists none of a submodule's files. */
function submoduleAbove(root: string, scope: string): string | undefined {
  const parts = scope.split("/");
  const ancestors = parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join("/"));
  const named = ancestors.filter((a) => !a.endsWith(".."));
  if (named.length === 0) return undefined;
  const out = gitSync(root, ["ls-tree", "-z", "HEAD", "--", ...named]).out;
  for (const record of out.split("\0")) {
    if (record.startsWith("160000 ")) return record.slice(record.indexOf("\t") + 1);
  }
  return undefined;
}

/**
 * Why `paths` cannot bound a source at `root`, or undefined when it can. An empty entry fails
 * every git call, and one outside the root matches no citation, so locate calls everything missing.
 */
export function scopeProblem(root: string, paths: unknown): string | undefined {
  if (paths === undefined || paths === null) return undefined;
  if (!Array.isArray(paths)) return `declares \`paths\` as a ${typeof paths}, not a list`;
  // Git works from the real directory, so `..` through a symlinked root lands beside its target.
  const base = realRoot(root);
  let positive = false;
  for (const entry of paths as unknown[]) {
    if (typeof entry !== "string") {
      return `declares paths entry ${scalarOrType(entry)}, which is not a string`;
    }
    if (entry === "")
      return `declares paths entry "", which is empty; omit \`paths\` for the whole root`;
    const { top, exclude, pattern } = pathspecMagic(entry);
    // Not quoted: reasons reach PR comments, and an absolute path names somebody's machine.
    if (isAbsolute(entry) || isAbsolute(pattern)) {
      return "declares a paths entry that is an absolute path; name it relative to `root`";
    }
    const shown = JSON.stringify(entry);
    // Citations are relative to the root, so a top-anchored match is one no citation names.
    if (top && !exclude) {
      return `declares paths entry ${shown}, which is relative to the repository top; name it relative to \`root\``;
    }
    const target = resolve(base, pattern);
    if (exclude) {
      // Nothing left in scope: rev-list finds no commit and the revision falls back to HEAD.
      if (!escapes(relative(target, base))) {
        return `declares paths entry ${shown}, which excludes the whole source root`;
      }
      continue;
    }
    positive = true;
    if (escapes(relative(base, target))) {
      return `declares paths entry ${shown}, which resolves outside the source root`;
    }
  }
  // Git reads an exclude-only pathspec from the repository top, widening the source past its root.
  if (paths.length > 0 && !positive) {
    return 'declares `paths` with only exclusions; add "." to keep the whole root, or omit `paths`';
  }
  return undefined;
}

const escapes = (rel: string): boolean =>
  rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);

function realRoot(root: string): string {
  try {
    return realpathSync(root);
  } catch {
    return resolve(root);
  }
}

const scalarOrType = (value: unknown): string =>
  value === null || typeof value === "number" || typeof value === "boolean"
    ? String(value)
    : Array.isArray(value)
      ? "a list"
      : `a ${typeof value}`;

/** The `top` and `exclude` magic of a pathspec, short or long form, and the pattern after it. */
function pathspecMagic(entry: string): { top: boolean; exclude: boolean; pattern: string } {
  if (!entry.startsWith(":")) return { top: false, exclude: false, pattern: entry };
  const long = /^:\(([^)]*)\)/.exec(entry);
  if (long) {
    const words = long[1]!.split(",").map((word) => word.trim().split(/[:=]/)[0]);
    return {
      top: words.includes("top"),
      exclude: words.includes("exclude"),
      pattern: entry.slice(long[0].length),
    };
  }
  const short = /^:([/!^]*):?/.exec(entry)!;
  const signs = short[1]!;
  return {
    top: signs.includes("/"),
    exclude: /[!^]/.test(signs),
    pattern: entry.slice(short[0].length),
  };
}

/**
 * What git itself makes of `paths` from `root`: its refusal of the pathspec, or a match outside the
 * root. Run by preflight, since the loader cannot run git and cannot read every kind of magic.
 */
export async function scopeRefusal(
  root: string,
  paths: readonly string[],
): Promise<string | undefined> {
  if (paths.length === 0) return undefined;
  let out: string;
  try {
    out = await git(root, ["ls-files", "-z", "--", ...paths]);
  } catch (error) {
    if (!(error instanceof GitCommandError)) throw error;
    return `git refuses \`paths\`: ${error.stderr.split("\n")[0]}`;
  }
  const outside = out.split("\0").find((path) => path.startsWith("../"));
  return outside === undefined
    ? undefined
    : `\`paths\` matches files outside the source root, such as ${outside}`;
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
    // `loadSources` turns this throw into an unloaded source naming the entry.
    const problem = scopeProblem(options.root, options.paths);
    if (problem) throw new Error(`Source "${options.id}" ${problem}`);
    this.id = options.id;
    this.root = options.root;
    this.citationFormat = options.citationFormat;
    this.paths = options.paths ?? [];
    // Checked once, when the source is built: a long-lived MCP server keeps its startup verdict.
    const refusal = unmatchedPaths(this.root, this.paths);
    if (refusal) throw new Error(`Source "${this.id}": ${refusal}`);
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
   * is exactly what `resolveCitedFile` exists to prevent.
   */
  async locate(path: string, locator?: string): Promise<LocationVerdict> {
    const full = resolveCitedFile(this.root, path, this.id);
    if (typeof full !== "string") return full;

    // `revision()` and `changedSince()` see only `paths`, so a citation outside them could never drift.
    const outside: LocationVerdict = {
      verdict: "missing",
      part: "path",
      detail: `${path} is outside the declared paths (${this.paths.join(", ")}) of source "${this.id}"`,
    };
    const patterned = this.paths.some(isPattern);
    if (this.paths.length > 0 && !patterned) {
      const scope = this.paths.map((p) => scopeOf(this.root, p));
      if (!scope.some((p) => p === "" || path === p || path.startsWith(`${p}/`))) return outside;
    }

    // Joined before the first await, so every locate issued together shares one `git status`.
    const state = this.workingState(path);
    state.catch(() => {});
    const declared = patterned ? this.declared() : undefined;
    declared?.catch(() => {});

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
    let inScope = true;
    try {
      working = await state;
      // Only a tracked file is listed, so this is asked once the file is known to be one.
      if (working === "committed" && declared) inScope = (await declared).has(path);
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
    if (!inScope) return outside;

    if (locator === undefined) return { verdict: "found" };

    const range = parseLineLocator(locator);
    if (!range) {
      return {
        verdict: "missing",
        part: "locator",
        detail: `"${locator}" is not a line range, and ${path} is addressed by line`,
      };
    }

    const lines = countLines(text);
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
  private listing: Promise<Set<string>> | undefined;

  /** Tracked files under `paths`, matched as `revision()` matches them; one listing per batch. */
  private declared(): Promise<Set<string>> {
    this.listing ??= Promise.resolve().then(async () => {
      this.listing = undefined;
      const out = await git(this.root, ["ls-files", "-z", "--", ...this.paths]);
      return new Set(out.split("\0").filter(Boolean));
    });
    return this.listing;
  }

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

const isPattern = (entry: string) => /[*?[\\]/.test(entry) || entry.startsWith(":");

/** A literal `paths` entry as git lists it from the root: `./docs/` is `docs`, `.` is "". */
function scopeOf(root: string, entry: string): string {
  const base = resolve(root);
  return relative(base, resolve(base, entry)).split(sep).join("/");
}

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
