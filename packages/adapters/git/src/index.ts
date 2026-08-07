import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  formatCitation,
  UnknownRevisionError,
  type LineRange,
  type SourceAdapter,
} from "@accreta/core";

export interface GitSourceOptions {
  id: string;
  /** Working tree of the repository. */
  root: string;
  /** Provenance template, from `accreta.config.yaml`. */
  citationFormat: string;
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

  constructor(options: GitSourceOptions) {
    this.id = options.id;
    this.root = options.root;
    this.citationFormat = options.citationFormat;
  }

  async revision(): Promise<string> {
    return (await git(this.root, ["rev-parse", "HEAD"])).trim();
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

    const out = await git(this.root, ["diff", "--name-only", revision, "HEAD"]);
    return out.split("\n").filter(Boolean).toSorted();
  }

  async read(path: string): Promise<string> {
    return readFile(join(this.root, path), "utf-8");
  }

  citation(path: string, lines?: LineRange): string {
    return formatCitation(this.citationFormat, {
      source: this.id,
      rev: this.pinnedRevision ?? "HEAD",
      path,
      lines,
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
