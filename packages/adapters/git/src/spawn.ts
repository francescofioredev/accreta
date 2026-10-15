import { spawn } from "node:child_process";
import { accessSync, constants as fsConstants, statSync } from "node:fs";
import { constants } from "node:os";
import { isAbsolute, join } from "node:path";

/** Read an env var as Windows does, whatever the case of its name. */
function envValue(
  env: NodeJS.ProcessEnv,
  name: string,
  platform: NodeJS.Platform,
): string | undefined {
  if (platform !== "win32") return env[name];
  const key = Object.keys(env).find((k) => k.toUpperCase() === name);
  return key === undefined ? undefined : env[key];
}

function runnable(file: string, platform: NodeJS.Platform): boolean {
  try {
    if (!statSync(file).isFile()) return false;
    if (platform !== "win32") accessSync(file, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * `name` from the absolute entries of PATH only. A bare spawn on Windows searches the cwd first,
 * so a `git.exe` committed at a source root would run; an empty or relative entry means the cwd too.
 */
export function findOnPath(
  name: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  const entries = (envValue(env, "PATH", platform) ?? "").split(platform === "win32" ? ";" : ":");
  const extensions =
    platform === "win32"
      ? (envValue(env, "PATHEXT", platform) ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
      : [""];
  for (const entry of entries) {
    // Windows allows a quoted entry, and libuv's own search honours it.
    const dir = platform === "win32" ? entry.replace(/^"(.*)"$/, "$1") : entry;
    if (!dir || !isAbsolute(dir)) continue;
    for (const extension of extensions) {
      const file = join(dir, name + extension);
      if (runnable(file, platform)) return file;
    }
  }
  return undefined;
}

const resolved = new Map<string, { path: string | undefined; file: string | undefined }>();

/** `findOnPath` once per process, again only if PATH itself changes. */
export function executable(name: string): string | undefined {
  const path = envValue(process.env, "PATH", process.platform);
  let entry = resolved.get(name);
  if (entry === undefined || entry.path !== path) {
    entry = { path, file: findOnPath(name, process.env) };
    resolved.set(name, entry);
  }
  return entry.file;
}

export class TimeoutError extends Error {
  constructor(
    readonly command: string,
    readonly timeoutMs: number,
  ) {
    super(`${command} did not finish within ${timeoutMs} ms`);
    this.name = "TimeoutError";
  }
}

export interface RunResult {
  exitCode: number;
  stdout: Buffer;
  stderr: Buffer;
}

/**
 * Run `file` and collect its output, killing it and every helper it started after `timeoutMs`.
 * `command` names the call in a timeout error.
 */
export function run(
  file: string,
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; command: string },
): Promise<RunResult> {
  return new Promise((resolveResult, reject) => {
    // Its own process group, so a timeout reaches the hooks and filters it started as well.
    const group = process.platform !== "win32";
    // Streamed, not execFile: its maxBuffer turns a large diff into an error.
    const child = spawn(file, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: group,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      try {
        if (group && child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        // Already gone.
      }
      // Not on close: a helper that outlived the kill would hold the pipes open.
      child.stdout.destroy();
      child.stderr.destroy();
      reject(new TimeoutError(options.command, options.timeoutMs));
    }, options.timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      resolveResult({
        exitCode: code ?? 128 + (signal ? constants.signals[signal] : 0),
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
      });
    });
  });
}
