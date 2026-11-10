import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { JudgeConfigError, JudgeUnavailableError, resolveJudgeSettings } from "@accreta/core";
import { createJudge } from "@accreta/judges";
import type { Workspace } from "../workspace.ts";
import { CONFIG_FILENAME } from "../workspace.ts";
import { printable, printableMessage, type CommandContext } from "./shared.ts";

const PROBE_TIMEOUT_MS = 15_000;
const MAX_SCANNED_BYTES = 1_000_000;
// Short values are common words, and a key is never this short.
const MIN_KEY_LENGTH = 8;
const KEY_LIKE = /key|token|secret|password|credential/i;

/** Every file doctor reads for a leaked key: the config and the knowledge base's markdown. */
function* scannedFiles(workspace: Workspace): Generator<string> {
  yield join(workspace.root, CONFIG_FILENAME);
  const stack = [join(workspace.root, workspace.config.knowledgeBase)];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) stack.push(path);
      else if (entry.isFile() && entry.name.endsWith(".md")) yield path;
    }
  }
}

function filesHolding(workspace: Workspace, secret: string): string[] {
  const found: string[] = [];
  for (const path of scannedFiles(workspace)) {
    try {
      if (statSync(path).size > MAX_SCANNED_BYTES) continue;
      if (readFileSync(path, "utf-8").includes(secret)) {
        found.push(relative(workspace.root, path).split("\\").join("/"));
      }
    } catch {
      // unreadable: not evidence either way
    }
  }
  return found;
}

/**
 * The `judge` section of `doctor`; nothing at all without a `judge:` block, so a knowledge base
 * that does not use one reads exactly as before. Returns 1 when something is broken. An
 * unreachable judge is a warning, never a failure: it is advisory (ADR-0014).
 */
export async function reportJudge(
  ctx: CommandContext,
  workspace: Workspace,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<number> {
  const settings = resolveJudgeSettings(workspace.config.judge, env);
  if (settings === null) return 0;
  let exitCode = 0;
  ctx.out("\njudge");

  for (const problem of settings.problems) {
    ctx.out(`  broken: ${printableMessage(problem, "  ")}`);
    exitCode = 1;
  }
  for (const key of settings.unknownKeys) {
    if (KEY_LIKE.test(key)) {
      ctx.out(`  broken: judge.${printable(key)} looks like a credential in ${CONFIG_FILENAME}`);
      ctx.out(`    → remove it; the key lives only in the variable api_key_env names`);
      exitCode = 1;
    } else {
      ctx.out(`  unknown: judge.${printable(key)} is not a setting and is ignored`);
    }
  }
  if (settings.urlInFile && !settings.urlFromEnv) {
    ctx.out(`  broken: judge.url in ${CONFIG_FILENAME} is not read`);
    ctx.out("    → set ACCRETA_JUDGE_URL instead; only the environment may move the judge");
    exitCode = 1;
  } else if (settings.urlInFile) {
    ctx.out(`  note: judge.url in ${CONFIG_FILENAME} is ignored; ACCRETA_JUDGE_URL wins`);
  }

  const variable = settings.apiKeyEnv;
  // A pasted key in api_key_env is not a variable name; never echo it.
  const named = variable.startsWith("ACCRETA_JUDGE_");
  const secret = named ? (env[variable]?.trim() ?? "") : "";
  if (named) {
    ctx.out(`  key: ${printable(variable)} is ${secret ? "set" : "not set"}`);
  } else {
    ctx.out("  broken: api_key_env holds something that is not a variable name");
    ctx.out("    → if it is a key, rotate it; name the variable that holds the key instead");
    exitCode = 1;
  }
  if (secret.length >= MIN_KEY_LENGTH) {
    for (const file of filesHolding(workspace, secret)) {
      ctx.out(`  broken: the key in ${printable(variable)} is written in ${printable(file)}`);
      ctx.out("    → remove it from the file, rotate the key, and keep it in the environment");
      exitCode = 1;
    }
  }
  if (exitCode !== 0) return exitCode;

  let judge;
  try {
    judge = createJudge(workspace.config, env, {
      retry: { attempts: 1, baseMs: 0 },
      timeoutMs: PROBE_TIMEOUT_MS,
    });
  } catch (error) {
    if (!(error instanceof JudgeConfigError)) throw error;
    ctx.out(`  broken: ${printableMessage(error.message, "  ")}`);
    return 1;
  }
  if (!judge?.probe) return 0;
  try {
    const probe = await judge.probe();
    ctx.out(
      `  ok: ${printable(probe.judge)} answered in ${probe.latencyMs} ms, model ${printable(probe.model)}`,
    );
    ctx.out("  note: page text sent to a judge leaves this machine (docs/judge.md)");
  } catch (error) {
    if (!(error instanceof JudgeUnavailableError)) throw error;
    ctx.out(`  unreachable: ${printableMessage(error.message, "  ")}`);
    ctx.out("    → search and lint carry on without it");
  }
  return 0;
}
