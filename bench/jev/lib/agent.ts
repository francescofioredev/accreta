import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** One headless agent session: the knowledge base's constitution appended, file tools only, a budget cap. */
export function agentSession(opts: {
  cwd: string;
  constitution: string;
  prompt: string;
  model: string;
  budgetUsd: number;
}): Promise<any> {
  const tools = "Read,Write,Edit,Glob,Grep";
  const args = [
    "-p",
    "--safe-mode",
    "--model",
    opts.model,
    "--output-format",
    "json",
    "--append-system-prompt",
    readFileSync(opts.constitution, "utf8"),
    "--tools",
    tools,
    "--allowedTools",
    tools,
    "--permission-mode",
    "acceptEdits",
    "--max-budget-usd",
    String(opts.budgetUsd),
  ];
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn("claude", args, { cwd: opts.cwd, stdio: ["pipe", "pipe", "pipe"] });
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
    child.stdin.end(opts.prompt);
  });
}

export const constitutionOf = (kb: string) => join(kb, "AGENTS.md");
