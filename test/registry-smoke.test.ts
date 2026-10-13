import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PUBLISHABLE, manifestOf, versionOf } from "../scripts/check-version.ts";
import {
  DELAYS,
  PACKAGES,
  check,
  handshake,
  handshakeProblems,
  waitForVersion,
} from "../scripts/registry-smoke.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const VERSION = versionOf("packages/cli");
// From source, so the logic is covered with no registry; the workflow points it at an install.
const fromSource = (bin: string) => [
  process.execPath,
  "--conditions=@accreta/source",
  join(REPO_ROOT, bin),
];
const CLI = fromSource("packages/cli/src/bin.ts");

const stubs = mkdtempSync(join(tmpdir(), "accreta-smoke-stub-"));
afterAll(() => rmSync(stubs, { recursive: true, force: true }));

/** A server that answers every request with `result`, standing in for a broken release. */
function stubServer(result: object): string[] {
  const path = join(stubs, `server-${Math.random().toString(36).slice(2)}.mjs`);
  writeFileSync(
    path,
    `import { createInterface } from "node:readline";\n` +
      `for await (const line of createInterface({ input: process.stdin })) {\n` +
      `  const { id } = JSON.parse(line);\n` +
      `  if (id !== undefined) console.log(JSON.stringify({ jsonrpc: "2.0", id, result: ${JSON.stringify(result)} }));\n` +
      `}\n`,
  );
  return [process.execPath, path];
}

test("it waits for every package publish.yml publishes", () => {
  // A package left off the list could still be propagating when the install asks for it.
  expect(PACKAGES.toSorted()).toEqual(PUBLISHABLE.map((dir) => manifestOf(dir).name).toSorted());
});

test("waiting retries until the registry shows the version", async () => {
  const sleeps: number[] = [];
  let calls = 0;
  await waitForVersion("1.2.3", {
    packages: ["accreta"],
    view: () => {
      calls++;
      if (calls < 3) throw new Error("E404");
      return "1.2.3";
    },
    sleep: async (seconds: number) => void sleeps.push(seconds),
    log: () => {},
  });
  expect(sleeps).toEqual(DELAYS.slice(0, 2));
});

test("waiting gives up after a bounded time, naming the package", async () => {
  const sleeps: number[] = [];
  const waited = waitForVersion("1.2.3", {
    packages: ["@accreta/core"],
    view: () => "1.2.2",
    sleep: async (seconds: number) => void sleeps.push(seconds),
    log: () => {},
  });
  await expect(waited).rejects.toThrow("@accreta/core@1.2.3 is still not on the registry");
  expect(sleeps).toEqual(DELAYS);
  expect(DELAYS.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(15 * 60);
});

test("the CLI's commands and both MCP entry points pass the check", async () => {
  await check(VERSION, CLI, { mcp: [fromSource("packages/mcp-server/src/bin.ts")] });
}, 60_000);

test("a CLI reporting another version fails the check", async () => {
  await expect(check("9.9.9", CLI)).rejects.toThrow(`--version printed "${VERSION}", not 9.9.9`);
});

test("a server with no tools fails the handshake", async () => {
  const result = await handshake(
    stubServer({ serverInfo: { name: "accreta", version: "1.2.3" }, tools: [] }),
  );
  expect(handshakeProblems(result, "1.2.3")).toEqual(["tools/list named [], without search_pages"]);
});

test("a server that never answers fails the handshake instead of hanging", async () => {
  const silent = join(stubs, "silent.mjs");
  writeFileSync(silent, "setInterval(() => {}, 1000);\n");
  const result = await handshake([process.execPath, silent], { timeoutMs: 500 });
  expect(handshakeProblems(result, "1.2.3")[0]).toStartWith("timed out");
});

test("a server answering for another version fails the handshake", async () => {
  const result = await handshake(
    stubServer({
      serverInfo: { name: "accreta", version: "1.2.2" },
      tools: [{ name: "search_pages" }],
    }),
  );
  expect(handshakeProblems(result, "1.2.3")).toEqual(["initialize named version 1.2.2, not 1.2.3"]);
});
