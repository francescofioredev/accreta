import { spawn, spawnSync } from "node:child_process";
import { accessSync, constants as fsConstants, statSync } from "node:fs";
import { constants } from "node:os";
import { isAbsolute, join, win32 } from "node:path";

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
  // Not PATHEXT: spawn refuses .bat and .cmd without a shell (CVE-2024-27980), and libuv tries only these.
  const extensions = platform === "win32" ? [".COM", ".EXE"] : [""];
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

/** `findOnPath` once per process, again if PATH changes; a miss is not kept, so installing git mends it. */
export function executable(name: string): string | undefined {
  const path = envValue(process.env, "PATH", process.platform);
  const entry = resolved.get(name);
  if (entry !== undefined && entry.path === path) return entry.file;
  const file = findOnPath(name, process.env);
  if (file === undefined) resolved.delete(name);
  else resolved.set(name, { path, file });
  return file;
}

/** The taskkill call that ends `pid`'s tree; from SystemRoot only, never PATH or the cwd (see `findOnPath`). */
export function treeKill(
  pid: number,
  env: NodeJS.ProcessEnv,
): { file: string; args: string[] } | undefined {
  const root = envValue(env, "SYSTEMROOT", "win32");
  if (root === undefined || !/^[A-Za-z]:[\\/]/.test(root)) return undefined;
  return {
    file: win32.join(root, "System32", "taskkill.exe"),
    args: ["/T", "/F", "/PID", String(pid)],
  };
}

// How long taskkill may block, shared by every pid one cleanup kills.
const TREE_KILL_MS = 3_000;

/** Ends `pid` with every helper it started; synchronous, since an `exit` handler cannot wait. */
function kill(pid: number, deadline = Date.now() + TREE_KILL_MS): void {
  if (process.platform !== "win32") {
    // Safe after the leader is reaped: the group id stays reserved while any member lives.
    process.kill(-pid, "SIGKILL");
    return;
  }
  // No process groups on Windows. A failed taskkill, "not found" included, falls back to git alone.
  const command = treeKill(pid, process.env);
  const left = deadline - Date.now();
  if (command !== undefined && left > 0) {
    const options = { stdio: "ignore", windowsHide: true, timeout: left } as const;
    if (spawnSync(command.file, command.args, options).status === 0) return;
  }
  process.kill(pid, "SIGKILL");
}

// Children still running, so accreta dying from a signal does not orphan git and its filters.
const live = new Set<number>();
const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

function killLive(): void {
  const deadline = Date.now() + TREE_KILL_MS;
  for (const pid of live) {
    try {
      kill(pid, deadline);
    } catch {
      // The whole group, or on Windows git, is gone.
    }
  }
  live.clear();
}

function reraise(signal: NodeJS.Signals): void {
  if (process.platform !== "win32") {
    process.kill(process.pid, signal);
    return;
  }
  // libuv on Windows raises only SIGINT, SIGTERM, SIGKILL and SIGQUIT; SIGHUP would throw ENOSYS.
  process.exit(128 + (constants.signals[signal] ?? 0));
}

const onSignal = Object.fromEntries(
  SIGNALS.map((signal) => [
    signal,
    () => {
      killLive();
      unguard();
      // Re-raised for the default exit, unless the host handles this signal itself.
      if (process.listenerCount(signal) === 0) reraise(signal);
    },
  ]),
) as Record<(typeof SIGNALS)[number], () => void>;

function guard(pid: number): void {
  if (live.size === 0) {
    // First in line: a host's own once-listener would otherwise unhook itself and leave us re-raising.
    for (const signal of SIGNALS) process.prependOnceListener(signal, onSignal[signal]);
    process.once("exit", killLive);
  }
  live.add(pid);
}

function unguard(): void {
  for (const signal of SIGNALS) process.off(signal, onSignal[signal]);
  process.off("exit", killLive);
}

function release(pid: number): void {
  if (!live.delete(pid) || live.size > 0) return;
  unguard();
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
  /** The signal that killed the child, if one did. */
  signal: NodeJS.Signals | null;
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
    const pid = child.pid;
    if (pid !== undefined) guard(pid);
    // A Windows pid may be reused after git's exit event, though a helper may still hold the pipes.
    const exited = () => !group && (child.exitCode !== null || child.signalCode !== null);
    // Deliberately, a helper that outlives git is then out of reach: taskkill on a recycled pid is worse.
    if (!group && pid !== undefined) child.once("exit", () => release(pid));
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      try {
        if (pid !== undefined && !exited()) kill(pid);
        else child.kill("SIGKILL");
      } catch {
        // Already gone.
      }
      if (pid !== undefined) release(pid);
      // Not on close: a helper that outlived the kill would hold the pipes open.
      child.stdout.destroy();
      child.stderr.destroy();
      reject(new TimeoutError(options.command, options.timeoutMs));
    }, options.timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      if (pid !== undefined) release(pid);
      if (settled) return;
      settled = true;
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (pid !== undefined) release(pid);
      if (settled) return;
      settled = true;
      resolveResult({
        exitCode: code ?? 128 + (signal ? constants.signals[signal] : 0),
        signal,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
      });
    });
  });
}
