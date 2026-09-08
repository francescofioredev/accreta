import { readFile } from "node:fs/promises";
import {
  formatCitation,
  parseLineLocator,
  resolveInside,
  UNPINNED_REVISION,
  UnknownRevisionError,
  type LocationVerdict,
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

  async changedSince(revision: string): Promise<string[]> {
    // `cat-file -e` is the cheap way to ask whether this repository has ever
    // heard of the revision. A shallow clone, a rewritten history or a revision
    // from a different repository all land here, and answering "nothing
    // changed" would be a lie that drift detection cannot detect.
    try {
      await git(this.root, ["cat-file", "-e", `${revision}^{commit}`]);
    } catch {
      throw new UnknownRevisionError(this.id, revision);
    }

    const args = ["diff", "--name-only", revision, "HEAD"];
    if (this.paths.length > 0) args.push("--", ...this.paths);
    const out = await git(this.root, args);
    return out.split("\n").filter(Boolean).toSorted();
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
   * whatever HEAD happens to be when the page is rendered later — that is the
   * difference between provenance and a guess.
   */
  private pinnedRevision: string | undefined;

  pinRevision(revision: string): void {
    this.pinnedRevision = revision;
  }
}
