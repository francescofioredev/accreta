import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export interface Usage {
  input_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  output_tokens: number;
  cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number };
  inference_geo?: string;
}

export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  canonicalModel?: string;
}

/** One agent session as `claude -p --output-format json` records it, tagged with arm and item. */
export interface Session {
  arm: string;
  item: string;
  /** Absent from the CLI's own record; the runners fill it from the arm. */
  model?: string;
  result: string;
  is_error: boolean;
  num_turns: number;
  total_cost_usd: number;
  usage: Usage;
  modelUsage?: Record<string, ModelUsage>;
}

/** One condition of an experiment: what the agent may touch, and where it starts. */
export interface Arm {
  id: string;
  model: string;
  /** Working directory; relative to the arms file. */
  cwd: string;
  /** Built-in tools; empty means none at all. */
  tools: string[];
  allowedTools?: string[];
  /** An MCP config file, relative to the arms file; the session sees no other server. */
  mcpConfig?: string;
  appendSystemPrompt?: string;
  budgetUsd: number;
}

export function readArms(path: string): Arm[] {
  const arms = JSON.parse(readFileSync(path, "utf-8")) as Arm[];
  const base = dirname(resolve(path));
  return arms.map((a) => ({
    ...a,
    cwd: resolve(base, a.cwd),
    ...(a.mcpConfig ? { mcpConfig: resolve(base, a.mcpConfig) } : {}),
  }));
}

export const totalTokens = (u: Usage) =>
  u.input_tokens + u.cache_creation_input_tokens + u.cache_read_input_tokens + u.output_tokens;

/** The headless Claude Code command for an arm, as bench/jev runs it. */
export function claudeArgs(arm: Arm): string[] {
  const args = ["-p", "--safe-mode", "--model", arm.model, "--output-format", "json"];
  args.push("--tools", arm.tools.join(","));
  const allowed = arm.allowedTools ?? arm.tools;
  if (allowed.length > 0) args.push("--allowedTools", allowed.join(","));
  if (arm.mcpConfig) args.push("--mcp-config", arm.mcpConfig, "--strict-mcp-config");
  if (arm.appendSystemPrompt) args.push("--append-system-prompt", arm.appendSystemPrompt);
  args.push("--max-budget-usd", String(arm.budgetUsd));
  return args;
}

export type Agent = (arm: Arm, item: string, prompt: string) => Promise<Session>;

export type Canned = Record<string, Record<string, Partial<Session>>>;

const EMPTY: Usage = {
  input_tokens: 0,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
  output_tokens: 0,
};

const fill = (arm: Arm, item: string, d: Partial<Session>): Session => ({
  model: arm.model,
  result: "",
  is_error: false,
  num_turns: 0,
  total_cost_usd: 0,
  usage: EMPTY,
  ...d,
  arm: arm.id,
  item,
});

/** Answers from a file, keyed by arm then item: the whole pipeline with no network and no model. */
export function dryAgent(canned: Canned): Agent {
  return async (arm, item) => {
    const c = canned[arm.id]?.[item];
    if (!c) throw new Error(`dry run: no canned session for arm "${arm.id}", item "${item}"`);
    return fill(arm, item, c);
  };
}

/** A real headless session. Spends money; only reached with --live. */
export const liveAgent: Agent = (arm, item, prompt) =>
  new Promise((done) => {
    const child = spawn("claude", claudeArgs(arm), {
      cwd: arm.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", () => {
      let d: Partial<Session> = {};
      try {
        d = JSON.parse(out) as Partial<Session>;
      } catch {
        d = { is_error: true, result: err || out };
      }
      done(fill(arm, item, d));
    });
    child.stdin.end(prompt);
  });

/** Every item through every arm, one session at a time so a budget cap means what it says. */
export async function runArms(
  agent: Agent,
  arms: readonly Arm[],
  items: readonly { id: string; prompt: string }[],
): Promise<Session[]> {
  const out: Session[] = [];
  for (const item of items) {
    for (const arm of arms) out.push(await agent(arm, item.id, item.prompt));
  }
  return out;
}
