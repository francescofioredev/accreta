#!/usr/bin/env node
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

/**
 * Runs what a user runs against a published version. Plain JavaScript under plain Node, so it
 * exercises the installed package and never the repository's `@accreta/source` condition.
 *
 *   registry-smoke.mjs wait <version>
 *   registry-smoke.mjs check <version> [--init "<cmd>"] [--mcp "<cmd>"]... -- <accreta cmd...>
 */

/** Every package publish.yml publishes; test/registry-smoke.test.ts keeps this in step. */
export const PACKAGES = [
  "@accreta/core",
  "@accreta/adapter-fs",
  "@accreta/adapter-git",
  "@accreta/adapter-delegated",
  "@accreta/adapters",
  "@accreta/mcp-server",
  "accreta",
];

/** Seconds between registry polls: doubling to a minute, about ten minutes in all. */
export const DELAYS = [5, 10, 20, 40, 60, 60, 60, 60, 60, 60, 60, 60, 60];

const npmView = (spec) =>
  execFileSync("npm", ["view", spec, "version"], { encoding: "utf-8", stdio: "pipe" }).trim();
const pause = (seconds) => new Promise((resolve) => setTimeout(resolve, seconds * 1000));

/** Resolves once every package shows `version`, since a fresh publish takes a while to propagate. */
export async function waitForVersion(
  version,
  { packages = PACKAGES, view = npmView, sleep = pause, delays = DELAYS, log = console.log } = {},
) {
  // One budget for all packages: per package, seven of them could wait over an hour.
  let attempt = 0;
  for (const name of packages) {
    const spec = `${name}@${version}`;
    for (;;) {
      let seen = "";
      try {
        seen = view(spec);
      } catch {}
      if (seen === version) break;
      const delay = delays[attempt++];
      if (delay === undefined) {
        throw new Error(`${spec} is still not on the registry after ${attempt} attempts`);
      }
      log(`${spec} is not visible yet; retrying in ${delay}s`);
      await sleep(delay);
    }
    log(`${spec} is on the registry`);
  }
}

/** MCP initialize and tools/list over stdio, with stdin closed after them as a client would. */
export function handshake(argv, { cwd, timeoutMs = 60_000 } = {}) {
  const messages = [
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "registry-smoke", version: "0.0.0" },
      },
    },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
  ];
  return new Promise((resolve) => {
    // Its own process group: npx and bunx run the server as a grandchild, which a kill of the
    // direct child leaves alive and holding the pipes.
    const server = spawn(argv[0], argv.slice(1), {
      cwd,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let code = null;
    let timedOut = false;
    let done = false;
    const killGroup = () => {
      try {
        process.kill(-server.pid, "SIGKILL");
      } catch {}
    };
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      const responses = [];
      const invalid = [];
      for (const line of stdout.split("\n")) {
        if (!line.trim()) continue;
        try {
          const message = JSON.parse(line);
          if (message?.jsonrpc !== "2.0") throw new Error("not JSON-RPC");
          responses.push(message);
        } catch {
          invalid.push(line);
        }
      }
      resolve({ code, stderr, responses, invalid, timedOut });
    };
    // Pipes still open a second after the end belong to a straggler; stop waiting on them.
    const settle = () => {
      killGroup();
      setTimeout(finish, 1000).unref();
    };
    // npx and bunx may download first, so the limit covers an install as well as the server.
    const timer = setTimeout(() => {
      timedOut = true;
      settle();
    }, timeoutMs);
    server.stdout.on("data", (chunk) => (stdout += chunk));
    server.stderr.on("data", (chunk) => (stderr += chunk));
    server.on("error", (error) => {
      stderr += String(error);
      finish();
    });
    server.on("exit", (exitCode) => {
      code = exitCode;
      settle();
    });
    server.on("close", finish);
    server.stdin.on("error", () => {});
    server.stdin.end(messages.map((message) => `${JSON.stringify(message)}\n`).join(""));
  });
}

/** What is wrong with a handshake's result; empty when the server named itself and its tools. */
export function handshakeProblems({ code, stderr, responses, invalid = [], timedOut }, version) {
  if (timedOut) return [`timed out; stderr: ${stderr.trim()}`];
  const problems = [];
  // Clients read stdout as protocol (see packages/mcp-server/src/stdio.ts): one log line breaks them.
  for (const line of invalid) {
    problems.push(`stdout carried a line that is not JSON-RPC: ${JSON.stringify(line)}`);
  }
  const initialize = responses.find((response) => response.id === 1)?.result;
  const list = responses.find((response) => response.id === 2)?.result;
  if (initialize?.serverInfo?.version !== version) {
    problems.push(`initialize named version ${initialize?.serverInfo?.version}, not ${version}`);
  }
  const tools = (list?.tools ?? []).map((tool) => tool.name);
  if (!tools.includes("search_pages")) {
    problems.push(`tools/list named [${tools.join(", ")}], without search_pages`);
  }
  if (code !== 0) problems.push(`exited ${code}`);
  if (stderr.includes("ExperimentalWarning")) problems.push("printed an ExperimentalWarning");
  if (problems.length > 0 && stderr.trim()) problems.push(`stderr: ${stderr.trim()}`);
  return problems;
}

function run(argv, cwd) {
  const result = spawnSync(argv[0], argv.slice(1), { cwd, encoding: "utf-8", timeout: 300_000 });
  // A command that never started leaves status null and its reason only in `error`.
  const stderr = `${result.stderr ?? ""}${result.error ? String(result.error) : ""}`;
  return { code: result.status, stdout: result.stdout ?? "", stderr };
}

/** Throws unless `argv` ran the step, exited 0, and printed no runtime warning. */
function step(argv, cwd, label = argv.slice(-1)[0]) {
  const result = run(argv, cwd);
  if (result.code !== 0 || result.stderr.includes("ExperimentalWarning")) {
    throw new Error(
      `${argv.join(" ")} exited ${result.code}\n${result.stdout}${result.stderr}`.trim(),
    );
  }
  console.log(`ok  ${label}`);
  return result.stdout;
}

/**
 * `--version`, then init, reindex, lint, drift, a page found by search, and an MCP handshake, in a
 * fresh directory outside any checkout so a template missing from the package cannot be found.
 */
export async function check(version, cli, { init = cli, mcp = [] } = {}) {
  const printed = step([...cli, "--version"], undefined).trim();
  if (printed !== version) {
    throw new Error(`${cli.join(" ")} --version printed "${printed}", not ${version}`);
  }
  console.log(`ok  --version is ${version}`);

  const dir = mkdtempSync(join(tmpdir(), "accreta-smoke-"));
  try {
    step([...init, "init"], dir);
    if (!existsSync(join(dir, "AGENTS.md"))) throw new Error("init wrote no AGENTS.md");
    step([...cli, "reindex"], dir);
    if (!existsSync(join(dir, ".accreta", "index.sqlite"))) {
      throw new Error("reindex wrote no .accreta/index.sqlite");
    }
    // A CLI that never ran its command also exits 0, so the output is what is asserted.
    const lint = step([...cli, "lint"], dir);
    if (!lint.includes("nothing to report")) throw new Error(`lint reported:\n${lint}`);
    // init declares an fs source, so drift loads an adapter from the package.
    const drift = step([...cli, "drift"], dir);
    if (!drift.includes("up to date")) throw new Error(`drift reported:\n${drift}`);

    writeFileSync(
      join(dir, "knowledge", "albedo.md"),
      "---\ntype: note\n---\n\n# Albedo\n\nThe fraction of light a surface reflects.\n",
    );
    step([...cli, "reindex"], dir, "reindex with a page");
    const search = step([...cli, "search", "reflects"], dir, "search");
    if (!search.includes("knowledge/albedo.md")) throw new Error(`search found:\n${search}`);

    for (const server of [[...cli, "mcp"], ...mcp]) {
      const problems = handshakeProblems(await handshake(server, { cwd: dir }), version);
      if (problems.length > 0) {
        throw new Error(`${server.join(" ")} handshake:\n  ${problems.join("\n  ")}`);
      }
      console.log(`ok  ${server.join(" ")} answers initialize and tools/list`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const words = (text) => text.split(/\s+/).filter(Boolean);

async function main(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { init: { type: "string" }, mcp: { type: "string", multiple: true } },
  });
  const [command, version, ...cli] = positionals;
  if (command === "wait" && version) return waitForVersion(version);
  if (command === "check" && version && cli.length > 0) {
    return check(version, cli, {
      init: values.init ? words(values.init) : cli,
      mcp: (values.mcp ?? []).map(words),
    });
  }
  throw new Error(
    "Usage: registry-smoke.mjs wait <version>\n" +
      '       registry-smoke.mjs check <version> [--init "<cmd>"] [--mcp "<cmd>"]... -- <cmd...>',
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
