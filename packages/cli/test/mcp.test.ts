import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/main.ts";
import { COMMAND_ARGS, refuseArguments, type CommandContext } from "../src/commands/shared.ts";

// Through the bin, as a user runs it; in the repository that means the source condition.
const BIN = [
  process.execPath,
  "--conditions=@accreta/source",
  join(import.meta.dir, "..", "src", "bin.ts"),
];
const MANIFEST = (dir: string) =>
  JSON.parse(readFileSync(join(import.meta.dir, "..", "..", dir, "package.json"), "utf-8")) as {
    name: string;
    version: string;
    dependencies?: Record<string, string>;
  };

let root = "";
let output: string[] = [];
let errors: string[] = [];

function ctx(): CommandContext {
  return { cwd: root, out: (line) => output.push(line), err: (line) => errors.push(line) };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "accreta-mcp-"));
  output = [];
  errors = [];
  delete process.env.ACCRETA_INDEX_PATH;
  delete process.env.ACCRETA_ROOT;
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

test("the CLI depends on the MCP server at its own version, so one install brings both", () => {
  // Inside the workspace every package resolves whether declared or not, so only
  // the manifest shows whether an installed CLI would find the server.
  const server = MANIFEST("mcp-server");
  expect(MANIFEST("cli").dependencies?.[server.name]).toBe(server.version);
});

test("accreta mcp answers an MCP initialize on stdio, and writes nothing else to stdout", async () => {
  expect(await run(["init"], ctx())).toBe(0);
  expect(await run(["reindex"], ctx())).toBe(0);

  const proc = Bun.spawn([...BIN, "mcp"], {
    cwd: root,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  proc.stdin.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "mcp-test", version: "0.0.0" },
      },
    })}\n`,
  );
  await proc.stdin.flush();
  // A client disconnecting closes stdin; the server has to exit on that, cleanly.
  proc.stdin.end();

  const lines = (await new Response(proc.stdout).text()).split("\n").filter(Boolean);
  expect(await proc.exited).toBe(0);
  expect(lines).toHaveLength(1);
  const response = JSON.parse(lines[0]!) as {
    id: number;
    result: { serverInfo: { name: string; version: string } };
  };
  expect(response.id).toBe(1);
  expect(response.result.serverInfo).toEqual({
    name: "accreta",
    version: MANIFEST("mcp-server").version,
  });
}, 15_000);

test("accreta mcp outside a knowledge base says so and fails", async () => {
  const proc = Bun.spawn([...BIN, "mcp"], {
    cwd: root,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(await proc.exited).toBe(1);
  expect(await new Response(proc.stderr).text()).toContain("No accreta.config.yaml found");
  expect(await new Response(proc.stdout).text()).toBe("");
}, 15_000);

test("an unknown mcp subcommand is refused rather than starting a server", async () => {
  expect(await run(["mcp", "nonsense"], ctx())).toBe(2);
  expect(errors.join("\n")).toContain('Unknown mcp subcommand "nonsense"');
});

test("accreta mcp help prints its own usage", async () => {
  expect(await run(["mcp", "help"], ctx())).toBe(0);
  expect(output.join("\n")).toContain("Usage: accreta mcp");
});

/** Spawned with stdin left open, so a server that starts by mistake shows up as a hang, not a pass. */
async function spawnMcp(...args: string[]) {
  const proc = Bun.spawn([...BIN, "mcp", ...args], {
    cwd: root,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => proc.kill(), 5_000);
  const code = await proc.exited;
  clearTimeout(timer);
  return {
    code,
    stdout: await new Response(proc.stdout).text(),
    stderr: await new Response(proc.stderr).text(),
  };
}

test("accreta mcp --help prints usage instead of starting a server", async () => {
  expect(await run(["init"], ctx())).toBe(0);
  expect(await run(["reindex"], ctx())).toBe(0);
  const { code, stdout, stderr } = await spawnMcp("--help");
  expect(code).toBe(0);
  expect(stdout).toContain("Usage: accreta");
  expect(stderr).not.toContain("MCP server ready");
}, 15_000);

test("a flag mcp does not declare is refused before a server starts", async () => {
  expect(await run(["init"], ctx())).toBe(0);
  expect(await run(["reindex"], ctx())).toBe(0);
  const { code, stderr } = await spawnMcp("--json");
  expect(code).toBe(2);
  expect(stderr).toContain("mcp does not take --json.");
}, 15_000);

test("every flag mcp declares is accepted", () => {
  for (const flag of COMMAND_ARGS.mcp!.flags) {
    const parsed = { positional: [], flags: [flag], afterEndOfOptions: [], problems: [] };
    expect(`${flag}: ${refuseArguments("mcp", parsed)}`).toBe(`${flag}: null`);
  }
});
