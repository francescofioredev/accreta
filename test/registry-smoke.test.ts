import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

/** A server that answers every request with `result`; `prelude` and `epilogue` break it. */
function stubServer(result: object, { prelude = "", epilogue = "" } = {}): string[] {
  const path = join(stubs, `server-${Math.random().toString(36).slice(2)}.mjs`);
  writeFileSync(
    path,
    `import { createInterface } from "node:readline";\n${prelude}\n` +
      `for await (const line of createInterface({ input: process.stdin })) {\n` +
      `  const { id } = JSON.parse(line);\n` +
      `  if (id !== undefined) console.log(JSON.stringify({ jsonrpc: "2.0", id, result: ${JSON.stringify(result)} }));\n` +
      `}\n${epilogue}\n`,
  );
  return [process.execPath, path];
}

const GOOD = {
  serverInfo: { name: "accreta", version: "1.2.3" },
  tools: [{ name: "search_pages" }],
};
const WARNING = "(node:1) ExperimentalWarning: SQLite is an experimental feature";

/** A CLI that does just enough for `check`, except for the step `mode` names. */
const stubCli = join(stubs, "cli.mjs");
writeFileSync(
  stubCli,
  `import { mkdirSync, writeFileSync } from "node:fs";
const [mode, command] = process.argv.slice(2);
switch (command) {
  case "--version":
    if (mode === "warn") console.error(${JSON.stringify(WARNING)});
    console.log("1.2.3");
    break;
  case "init":
    mkdirSync("knowledge");
    writeFileSync("AGENTS.md", "");
    break;
  case "reindex":
    mkdirSync(".accreta", { recursive: true });
    writeFileSync(".accreta/index.sqlite", "");
    break;
  case "lint":
    console.log(mode === "lint-finds" ? "1 finding(s) across 1 page(s)." : "nothing to report");
    break;
  case "drift":
    if (mode === "drift-fails") throw new Error("Cannot find module '@accreta/adapter-fs'");
    console.log("example @ e3b0c44298fc\\n  up to date");
    break;
  case "search":
    console.log(mode === "search-misses" ? "0 result(s)." : "knowledge/albedo.md  [note]");
    break;
}
`,
);
const cliIn = (mode: string) => [process.execPath, stubCli, mode];

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

test("the wait budget is shared by every package, not granted to each", async () => {
  const sleeps: number[] = [];
  const failures = new Map([
    ["@accreta/core", 2],
    ["accreta", 2],
  ]);
  await waitForVersion("1.2.3", {
    packages: ["@accreta/core", "accreta"],
    view: (spec: string) => {
      const name = spec.slice(0, spec.lastIndexOf("@"));
      const left = failures.get(name) ?? 0;
      failures.set(name, left - 1);
      if (left > 0) throw new Error("E404");
      return "1.2.3";
    },
    sleep: async (seconds: number) => void sleeps.push(seconds),
    log: () => {},
  });
  expect(sleeps).toEqual(DELAYS.slice(0, 4));
});

test("the CLI's commands and both MCP entry points pass the check", async () => {
  await check(VERSION, CLI, { mcp: [fromSource("packages/mcp-server/src/bin.ts")] });
}, 60_000);

test("a CLI reporting another version fails the check", async () => {
  await expect(check("9.9.9", CLI)).rejects.toThrow(`--version printed "${VERSION}", not 9.9.9`);
});

test("an ExperimentalWarning from --version fails the check", async () => {
  await expect(check("1.2.3", cliIn("warn"))).rejects.toThrow("ExperimentalWarning");
});

test.each([
  ["lint-finds", "lint reported"],
  ["drift-fails", "Cannot find module '@accreta/adapter-fs'"],
  ["search-misses", "search found"],
])("a CLI whose step goes wrong (%s) fails the check", async (mode, message) => {
  await expect(check("1.2.3", cliIn(mode))).rejects.toThrow(message);
});

test("a server with no tools fails the handshake", async () => {
  const result = await handshake(
    stubServer({ serverInfo: { name: "accreta", version: "1.2.3" }, tools: [] }),
  );
  expect(handshakeProblems(result, "1.2.3")).toEqual(["tools/list named [], without search_pages"]);
});

test("a server answering for another version fails the handshake", async () => {
  const result = await handshake(
    stubServer({ ...GOOD, serverInfo: { name: "accreta", version: "1.2.2" } }),
  );
  expect(handshakeProblems(result, "1.2.3")).toEqual(["initialize named version 1.2.2, not 1.2.3"]);
});

test("a server that writes anything but JSON-RPC to stdout fails the handshake", async () => {
  // Every MCP client reads stdout as protocol, so one log line there breaks them all.
  const result = await handshake(stubServer(GOOD, { prelude: `console.log("starting up");` }));
  expect(handshakeProblems(result, "1.2.3")).toEqual([
    'stdout carried a line that is not JSON-RPC: "starting up"',
  ]);
});

test("a server that exits non-zero fails the handshake", async () => {
  const result = await handshake(stubServer(GOOD, { epilogue: "process.exit(3);" }));
  expect(handshakeProblems(result, "1.2.3")).toEqual(["exited 3"]);
});

test("a server that prints an ExperimentalWarning fails the handshake", async () => {
  const prelude = `console.error(${JSON.stringify(WARNING)});`;
  const result = await handshake(stubServer(GOOD, { prelude }));
  expect(handshakeProblems(result, "1.2.3")).toContain("printed an ExperimentalWarning");
});

test("a server that crashes before answering fails the handshake", async () => {
  const result = await handshake(
    stubServer(GOOD, { prelude: `console.error("boom"); process.exit(1);` }),
  );
  expect(handshakeProblems(result, "1.2.3")).toEqual([
    "initialize named version undefined, not 1.2.3",
    "tools/list named [], without search_pages",
    "exited 1",
    "stderr: boom",
  ]);
});

test("a server that never answers fails the handshake instead of hanging", async () => {
  const silent = join(stubs, "silent.mjs");
  writeFileSync(silent, "setInterval(() => {}, 1000);\n");
  const result = await handshake([process.execPath, silent], { timeoutMs: 500 });
  expect(handshakeProblems(result, "1.2.3")[0]).toStartWith("timed out");
});

test("a server behind a wrapper is killed at the timeout, grandchildren included", async () => {
  // npx and bunx start the server as a grandchild, which keeps the pipes open after a plain kill.
  const silent = join(stubs, "silent-wrapped.mjs");
  writeFileSync(silent, "setInterval(() => {}, 1000);\n");
  const started = Date.now();
  const wrapped = ["sh", "-c", `"${process.execPath}" "${silent}"; true`];
  const result = await handshake(wrapped, { timeoutMs: 500 });
  expect(result.timedOut).toBe(true);
  expect(Date.now() - started).toBeLessThan(5_000);
}, 10_000);

test("the workflow tests a release with the script that release shipped", () => {
  // main's script judging an older release fails on commands that release never had.
  const workflow = readFileSync(
    join(REPO_ROOT, ".github", "workflows", "registry-smoke.yml"),
    "utf-8",
  );
  const checkouts = workflow.match(/uses: actions\/checkout@v\d+/g) ?? [];
  expect(checkouts.length).toBeGreaterThan(0);
  const pinned = workflow.match(/ref: v\$\{\{ needs\.version\.outputs\.version \}\}/g) ?? [];
  expect(pinned).toHaveLength(checkouts.length);
  expect(workflow.match(/persist-credentials: false/g) ?? []).toHaveLength(checkouts.length);
});
