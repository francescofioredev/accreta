#!/usr/bin/env bun
/**
 * Tier C baseline: a coding agent ingests got's source/ at v13.0.0 into a fresh knowledge base
 * made by `accreta init --preset codebase`, three independent runs. The source later moves to
 * v14.4.0 for drift.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { agentSession, constitutionOf } from "../lib/agent.ts";
import { EXTERNAL, REPO, RESULTS } from "../lib/paths.ts";

export const GOT_URL = "https://github.com/sindresorhus/got";
export const FROM_TAG = "v13.0.0";
export const TO_TAG = "v14.4.0";
export const AGENT = "claude-opus-5-5";
export const RUNS = 3;
export const BUDGET_USD = 20;
export const RUNS_DIR = join(EXTERNAL, "got-runs");
const CLI = join(REPO, "packages", "cli", "src", "bin.ts");

function scaffold(run: number): string {
  const dir = join(RUNS_DIR, `run${run}`);
  if (existsSync(join(dir, "kb", "sources", "got.yaml"))) return dir;
  mkdirSync(join(dir, "kb"), { recursive: true });
  execFileSync("git", ["clone", "--quiet", GOT_URL, join(dir, "repo")]);
  execFileSync("git", ["-C", join(dir, "repo"), "checkout", "--quiet", FROM_TAG]);
  execFileSync("bun", ["--conditions=@accreta/source", CLI, "init", "--preset", "codebase"], {
    cwd: join(dir, "kb"),
  });
  rmSync(join(dir, "kb", "sources", "example.yaml"), { force: true });
  writeFileSync(
    join(dir, "kb", "sources", "got.yaml"),
    "id: got\ntype: git\nroot: ../repo\npaths:\n  - source/\n",
  );
  return dir;
}

const prompt = (rev: string) => `Ingest one source into the knowledge base in kb/.

The method is kb/AGENTS.md, which is also in your system prompt; the vocabulary is kb/accreta.config.yaml. Follow both.

Source to ingest: the got HTTP client library's source code, the directory repo/source/, source id \`got\`, revision ${rev}.
Paths in citations are relative to the repository root, for example: \`got @ ${rev.slice(0, 7)} · source/core/options.ts#L120-L134\`.

Write pages under kb/knowledge/. Never edit anything under repo/.
When the source is ingested, stop and reply with one line listing the pages you wrote.`;

if (import.meta.main) {
  const only = process.argv
    .find((a) => a.startsWith("--runs="))
    ?.slice(7)
    .split(",")
    .map(Number);
  const runs = Array.from({ length: RUNS }, (_, r) => r + 1).filter(
    (r) => !only || only.includes(r),
  );
  // Clone before any session starts: a synchronous clone blocks the event loop, and a session
  // whose prompt is not on stdin within 3 seconds exits without running.
  const dirs = new Map(runs.map((run) => [run, scaffold(run)]));
  const results = await Promise.all(
    runs.map(async (run) => {
      const dir = dirs.get(run)!;
      const marker = join(dir, ".ingested.json");
      if (existsSync(marker)) {
        const done = JSON.parse(readFileSync(marker, "utf8"));
        if (!done.error) return done;
      }
      const rev = execFileSync("git", ["-C", join(dir, "repo"), "rev-parse", "HEAD"])
        .toString()
        .trim();
      const d = await agentSession({
        cwd: dir,
        constitution: constitutionOf(join(dir, "kb")),
        prompt: prompt(rev),
        model: AGENT,
        budgetUsd: BUDGET_USD,
      });
      const record = {
        run,
        revision: rev,
        code: d.code,
        wall_ms: d.wall_ms,
        duration_api_ms: d.duration_api_ms,
        num_turns: d.num_turns,
        total_cost_usd: d.total_cost_usd,
        usage: d.usage,
        modelUsage: d.modelUsage,
        result: d.result,
        is_error: d.is_error,
        error: d.error,
      };
      writeFileSync(marker, JSON.stringify(record, null, 1));
      process.stderr.write(
        `got run ${run}: ${d.num_turns} turns, $${d.total_cost_usd?.toFixed?.(2)}, ${Math.round(d.wall_ms / 60000)} min\n`,
      );
      return record;
    }),
  );
  if (!only) {
    mkdirSync(RESULTS, { recursive: true });
    writeFileSync(
      join(RESULTS, "r-c-ingest.json"),
      JSON.stringify(
        {
          run_at: new Date().toISOString(),
          agent: AGENT,
          repo: `${GOT_URL}@${FROM_TAG}`,
          budget_usd: BUDGET_USD,
          sessions: results,
        },
        null,
        1,
      ) + "\n",
    );
  }
  console.log("done");
}
