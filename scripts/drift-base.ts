#!/usr/bin/env bun
import { writeFileSync } from "node:fs";

/** Picks the base-branch commit whose drift the pull request's drift is compared with. */

export type BaseChoice =
  { kind: "base"; revision: string } | { kind: "none"; reason: string } | { kind: "shallow" };

async function git(cwd: string, args: string[]): Promise<string | null> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  return code === 0 ? out.trim() : null;
}

/** HEAD^1 is the base only in GitHub's test merge; a head that merged main has its own HEAD^1. */
export async function chooseBase(
  cwd: string,
  pr: { head?: string; base?: string },
): Promise<BaseChoice> {
  if ((await git(cwd, ["rev-parse", "--is-shallow-repository"])) === "true") {
    return { kind: "shallow" };
  }
  if (!pr.head || !pr.base) return { kind: "none", reason: "this is not a pull request" };

  const head = await git(cwd, ["rev-parse", "HEAD"]);
  const second = await git(cwd, ["rev-parse", "-q", "--verify", "HEAD^2"]);
  if (second === pr.head) {
    const first = await git(cwd, ["rev-parse", "HEAD^1"]);
    if (first) return { kind: "base", revision: first };
  } else if (head === pr.head) {
    const mergeBase = await git(cwd, ["merge-base", pr.base, "HEAD"]);
    if (mergeBase) return { kind: "base", revision: mergeBase };
    return { kind: "none", reason: `the base commit ${pr.base} is not in this checkout` };
  }
  return {
    kind: "none",
    reason: "HEAD is neither the pull request's head nor GitHub's merge of it",
  };
}

async function main(): Promise<number> {
  const choice = await chooseBase(process.cwd(), {
    head: process.env.PR_HEAD,
    base: process.env.PR_BASE,
  });
  if (choice.kind === "shallow") {
    console.log(
      "::error::The checkout is shallow, so drift cannot place the revisions pages were verified at. Check out with `fetch-depth: 0`.",
    );
    return 1;
  }
  if (choice.kind === "none") {
    console.log(
      `::notice::No base branch to compare with: ${choice.reason}. Every page counts as new.`,
    );
    return 0;
  }
  const out = process.argv[2];
  if (!out) throw new Error("Usage: drift-base.ts <file to write the base revision to>");
  writeFileSync(out, `${choice.revision}\n`, "utf-8");
  return 0;
}

if (import.meta.main) process.exitCode = await main();
