import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
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
import { executable, run } from "./spawn.ts";

export { TimeoutError } from "./spawn.ts";

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

// 40x the slowest call measured in a 50,000-file, 5,000-commit repo (status, 1.5 s; rev-list 42 ms, warm).
// A hung filter must not hang `drift`.
const DEFAULT_TIMEOUT_MS = 60_000;

function timeoutMs(): number {
  const raw = process.env.ACCRETA_GIT_TIMEOUT_MS;
  if (raw === undefined || raw === "") return DEFAULT_TIMEOUT_MS;
  const ms = Number(raw);
  if (!Number.isInteger(ms) || ms <= 0) {
    throw new Error(`ACCRETA_GIT_TIMEOUT_MS must be a whole number of milliseconds, not "${raw}"`);
  }
  return ms;
}

// Each points git at another repository, or another repository's objects; a hook sets the first three.
// GIT_NAMESPACE stays: it scopes only transfer commands, and changed none of these calls' output.
const FOREIGN_REPOSITORY = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_COMMON_DIR",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  // These clash with --literal-pathspecs, or change what a declared `paths` pattern matches.
  "GIT_GLOB_PATHSPECS",
  "GIT_NOGLOB_PATHSPECS",
  "GIT_ICASE_PATHSPECS",
  "GIT_LITERAL_PATHSPECS",
];

function gitEnv(extraEnv: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  // accreta only reads; without this `status` rewrites .git/index and a user's commit can hit index.lock.
  // LC_ALL=C: git's messages reach users and reports, so they read the same on every machine.
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_OPTIONAL_LOCKS: "0",
    LC_ALL: "C",
    ...extraEnv,
  };
  // GIT_DIFF_OPTS would override the -U0 that hunk parsing depends on.
  delete env.GIT_DIFF_OPTS;
  for (const name of FOREIGN_REPOSITORY) delete env[name];
  return env;
}

// Trust: the source's .git/config, and all it includes, runs as code; the timeout bounds a hang only.
// fsmonitor runs in status, ls-files and check-attr and only saves time; filters decide what is on disk.
// safe.bareRepository: a git dir inside the corpus must not lend its config; git before 2.38 ignores it.
const HARDENED = ["-c", "core.fsmonitor=false", "-c", "safe.bareRepository=explicit"];

/** Run a git command in the repository, returning stdout. */
async function git(
  root: string,
  args: string[],
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<string> {
  const env = gitEnv(extraEnv);
  const file = executable("git");
  if (file === undefined) {
    throw Object.assign(new Error("spawn git ENOENT"), { code: "ENOENT", path: "git" });
  }
  // The subcommand only: locate's details must name no path.
  const command = `git ${args.find((arg) => !arg.startsWith("-")) ?? ""}`;
  const { exitCode, signal, stdout, stderr } = await run(file, [...HARDENED, ...args], {
    cwd: root,
    env,
    timeoutMs: timeoutMs(),
    command,
  });
  // Not a GitCommandError: git said nothing about the repository, so no caller may read it as an answer.
  if (signal !== null) throw new Error(`${command} was killed by ${signal}`);
  if (exitCode === 0) return stdout.toString("utf-8");
  throw new GitCommandError(args, exitCode, stderr.toString("utf-8").trim());
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
  } catch (error) {
    // Git that cannot start or times out has not said the root is no repository.
    if (error instanceof GitCommandError) return false;
    throw error;
  }
}

function gitSync(root: string, args: string[], stdout: "pipe" | "ignore" = "pipe") {
  const file = executable("git");
  if (file === undefined) return { status: null, out: "" };
  // Synchronous, so no process group: these calls run no filter or fsmonitor that could outlive git.
  const result = spawnSync(file, [...HARDENED, ...args], {
    cwd: root,
    env: gitEnv(),
    stdio: ["ignore", stdout, "ignore"],
    timeout: timeoutMs(),
    killSignal: "SIGKILL",
  });
  // A timeout or a signal is no answer, like a git that cannot start: null, never an exit code.
  const status = result.signal === null ? result.status : null;
  return { status, out: status === null ? "" : (result.stdout?.toString("utf-8") ?? "") };
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
      // A promisor remote would fetch a frontmatter revision. Env var, not the flag: an older git ignores it
      // instead of failing; there is no guard on a git without it.
      await git(this.root, ["cat-file", "-e", `${revision}^{commit}`], { GIT_NO_LAZY_FETCH: "1" });
      return true;
    } catch (error) {
      if (error instanceof GitCommandError) return false;
      throw error;
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
    // --end-of-options: the revision comes from page frontmatter, so it must never read as a flag.
    const args = [
      "diff",
      "--name-only",
      "-z",
      "--no-renames",
      "--relative",
      "--end-of-options",
      revision,
      "HEAD",
    ];
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
      "--end-of-options",
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
