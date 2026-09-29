import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/main.ts";
import type { CommandContext } from "../src/commands/shared.ts";

const MAIN = join(import.meta.dir, "..", "src", "main.ts");
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

/** Read stdout up to the first newline: the stdio transport frames one JSON-RPC message per line. */
async function firstLine(stream: ReadableStream<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";
  for await (const chunk of stream) {
    text += decoder.decode(chunk, { stream: true });
    const newline = text.indexOf("\n");
    if (newline >= 0) return text.slice(0, newline);
  }
  return text;
}

test("the CLI depends on the MCP server at its own version, so one install brings both", () => {
  // Inside the workspace every package resolves whether declared or not, so only
  // the manifest shows whether an installed CLI would find the server.
  const server = MANIFEST("mcp-server");
  expect(MANIFEST("cli").dependencies?.[server.name]).toBe(server.version);
});

test("accreta mcp answers an MCP initialize on stdio, and writes nothing else to stdout", async () => {
  expect(await run(["init"], ctx())).toBe(0);
  expect(await run(["reindex"], ctx())).toBe(0);

  const proc = Bun.spawn(["bun", MAIN, "mcp"], {
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

  const response = JSON.parse(await firstLine(proc.stdout)) as {
    id: number;
    result: { serverInfo: { name: string; version: string } };
  };
  expect(response.id).toBe(1);
  expect(response.result.serverInfo).toEqual({
    name: "accreta",
    version: MANIFEST("mcp-server").version,
  });

  // A client disconnecting closes stdin; the server has to exit on that, cleanly.
  proc.stdin.end();
  expect(await proc.exited).toBe(0);
}, 15_000);

test("accreta mcp outside a knowledge base says so and fails", async () => {
  const proc = Bun.spawn(["bun", MAIN, "mcp"], {
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
  expect(await run(["mcp", "nonsense"], ctx())).toBe(1);
  expect(errors.join("\n")).toContain('Unknown mcp subcommand "nonsense"');
});
