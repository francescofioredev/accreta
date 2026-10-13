// The same tasks through a CLI-only and an MCP-only agent: success and tokens.
// bun bench/eval/surfaces.ts --tasks t.json --arms arms.json [--a cli-only --b mcp-only] (--canned c.json | --live) [--out <dir>]
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { dryAgent, liveAgent, readArms, runArms, type Canned } from "./lib/agent.ts";
import { scoreSurfaces, validateTasks, type SurfacesScore } from "./lib/surfaces.ts";

const readJson = <T>(path: string) => JSON.parse(readFileSync(path, "utf-8")) as T;

export async function runSurfaces(opts: {
  tasks: string;
  arms: string;
  a: string;
  b: string;
  canned?: string;
  live?: boolean;
  out?: string;
}): Promise<SurfacesScore> {
  const tasks = validateTasks(readJson<unknown>(opts.tasks));
  const all = readArms(opts.arms);
  const arms = [opts.a, opts.b].map((id) => {
    const arm = all.find((x) => x.id === id);
    if (!arm) throw new Error(`no arm "${id}" in ${opts.arms}`);
    return arm;
  });
  if (!opts.live && !opts.canned) throw new Error("pass --canned <file> for a dry run, or --live");
  const agent = opts.live ? liveAgent : dryAgent(readJson<Canned>(opts.canned!));
  const sessions = await runArms(agent, arms, tasks);
  const score = scoreSurfaces(tasks, sessions, [opts.a, opts.b]);
  if (opts.out) {
    mkdirSync(opts.out, { recursive: true });
    writeFileSync(join(opts.out, "sessions.json"), JSON.stringify({ arms, sessions }, null, 2));
    writeFileSync(join(opts.out, "score.json"), JSON.stringify(score, null, 2));
  }
  return score;
}

if (import.meta.main) {
  const { values: v } = parseArgs({
    options: {
      tasks: { type: "string" },
      arms: { type: "string" },
      a: { type: "string", default: "cli-only" },
      b: { type: "string", default: "mcp-only" },
      canned: { type: "string" },
      live: { type: "boolean", default: false },
      out: { type: "string" },
    },
  });
  if (!v.tasks || !v.arms) {
    console.error("usage: surfaces.ts --tasks t.json --arms arms.json (--canned c.json | --live)");
    process.exit(2);
  }
  const score = await runSurfaces({ ...v, tasks: v.tasks, arms: v.arms, a: v.a!, b: v.b! });
  console.log(JSON.stringify(score, null, 2));
}
