#!/usr/bin/env bun
/**
 * Tier A baseline: a coding agent ingests two RFCs into a fresh clone of accreta-atlas, following
 * its constitution, three independent runs. Its citations become tier A's labels, and its token
 * bill is the cost ingest triage would cut.
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EXTERNAL, RESULTS } from "../lib/paths.ts";

export const ATLAS_URL = "https://github.com/francescofioredev/accreta-atlas";
export const ATLAS_COMMIT = "4c66c8c";
export const AGENT = "claude-opus-5-5";
export const RUNS = 3;
export const BUDGET_USD = 20;
export const TARGETS = [
  { rfc: "RFC9111", source: "rfc-http", path: "kb/corpus/rfc/rfc9111.txt" },
  { rfc: "RFC6455", source: "rfc-core", path: "kb/corpus/rfc/rfc6455.txt" },
] as const;
export const RUNS_DIR = join(EXTERNAL, "atlas-runs");

const prompt = (
  t: (typeof TARGETS)[number],
  rev: string,
) => `Ingest one source into the knowledge base in kb/.

The method is kb/AGENTS.md, which is also in your system prompt; the vocabulary is kb/accreta.config.yaml. Follow both.

Source to ingest: ${t.rfc}, the file ${t.path}, source id \`${t.source}\`, revision ${rev}.
Cite in the configured format, for example: \`${t.source} @ ${rev.slice(0, 7)} · ${t.path}#L120-L134\`.

Write pages under kb/knowledge/. Do not ingest any other RFC, and never edit anything under kb/corpus/.
When the source is ingested, stop and reply with one line listing the pages you wrote.`;

function clone(run: number): string {
  const dir = join(RUNS_DIR, `run${run}`);
  if (!existsSync(dir)) {
    mkdirSync(RUNS_DIR, { recursive: true });
    execFileSync("git", ["clone", "--quiet", ATLAS_URL, dir]);
    execFileSync("git", ["-C", dir, "checkout", "--quiet", ATLAS_COMMIT]);
  }
  return dir;
}

function session(dir: string, text: string): Promise<any> {
  const args = [
    "-p",
    "--safe-mode",
    "--model",
    AGENT,
    "--output-format",
    "json",
    "--append-system-prompt",
    readFileSync(join(dir, "kb", "AGENTS.md"), "utf8"),
    "--tools",
    "Read,Write,Edit,Glob,Grep",
    "--allowedTools",
    "Read,Write,Edit,Glob,Grep",
    "--permission-mode",
    "acceptEdits",
    "--max-budget-usd",
    String(BUDGET_USD),
  ];
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn("claude", args, { cwd: dir, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => {
      let d: any = {};
      try {
        d = JSON.parse(out);
      } catch {
        d = { error: err || out };
      }
      resolve({ code, wall_ms: Date.now() - started, ...d });
    });
    child.stdin.end(text);
  });
}

if (import.meta.main) {
  const results = await Promise.all(
    Array.from({ length: RUNS }, async (_, r) => {
      const run = r + 1;
      const dir = clone(run);
      const rev = execFileSync("git", [
        "-C",
        dir,
        "log",
        "-1",
        "--format=%H",
        "--",
        "kb/corpus/rfc/",
      ])
        .toString()
        .trim();
      const sessions = [];
      for (const t of TARGETS) {
        const marker = join(dir, `.ingested-${t.rfc}.json`);
        if (existsSync(marker)) {
          sessions.push(JSON.parse(readFileSync(marker, "utf8")));
          continue;
        }
        const d = await session(dir, prompt(t, rev));
        const record = {
          run,
          rfc: t.rfc,
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
        sessions.push(record);
        process.stderr.write(
          `run ${run} ${t.rfc}: ${d.num_turns} turns, $${d.total_cost_usd?.toFixed?.(2)}, ${Math.round(d.wall_ms / 60000)} min\n`,
        );
      }
      return sessions;
    }),
  );
  mkdirSync(RESULTS, { recursive: true });
  writeFileSync(
    join(RESULTS, "r-a-ingest.json"),
    JSON.stringify(
      {
        run_at: new Date().toISOString(),
        agent: AGENT,
        atlas: `${ATLAS_URL}@${ATLAS_COMMIT}`,
        budget_usd: BUDGET_USD,
        sessions: results.flat(),
      },
      null,
      1,
    ) + "\n",
  );
  console.log("done");
}
