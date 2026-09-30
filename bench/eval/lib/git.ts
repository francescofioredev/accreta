export class GitError extends Error {}

/** Run git and return stdout; a non-zero exit throws with git's own message. */
export function git(cwd: string, ...args: string[]): string {
  const proc = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (proc.exitCode !== 0) {
    throw new GitError(`git ${args.join(" ")} in ${cwd}: ${proc.stderr.toString().trim()}`);
  }
  return proc.stdout.toString();
}

export const revParse = (cwd: string, rev: string) =>
  git(cwd, "rev-parse", "--verify", "--quiet", `${rev}^{commit}`).trim();

/** A file at a revision, or null when it is not in that tree; `./` keeps the path relative to `cwd`. */
export function showAt(cwd: string, rev: string, path: string): string | null {
  const proc = Bun.spawnSync(["git", "show", `${rev}:./${path}`], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  return proc.exitCode === 0 ? proc.stdout.toString() : null;
}
