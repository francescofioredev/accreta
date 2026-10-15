import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { run } from "../src/main.ts";
import { isControl } from "../src/commands/mcp-config.ts";
import type { CommandContext } from "../src/commands/shared.ts";

const ENV = ["HOME", "PATH", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "XDG_CONFIG_HOME", "APPDATA"];
const saved = Object.fromEntries(ENV.map((key) => [key, process.env[key]]));

let root = "";
let home = "";
let output: string[] = [];
let errors: string[] = [];

function ctx(): CommandContext {
  return { cwd: root, out: (line) => output.push(line), err: (line) => errors.push(line) };
}
const cli = (...argv: string[]) => run(argv, ctx());
const stdout = () => output.join("\n");
const stderr = () => errors.join("\n");
const json = (path: string) => JSON.parse(readFileSync(path, "utf-8")) as Record<string, any>;
function write(path: string, text: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, "utf-8");
}
function executableAt(path: string) {
  write(path, "#!/bin/sh\n");
  chmodSync(path, 0o755);
}
/** A PATH holding only an `accreta` executable in `dir`. */
function accretaIn(dir: string) {
  executableAt(join(dir, "accreta"));
  process.env.PATH = dir;
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "accreta-mcp-safety-"));
  home = mkdtempSync(join(tmpdir(), "accreta-mcp-safety-home-"));
  for (const key of ENV) if (key !== "PATH") delete process.env[key];
  process.env.HOME = home;
  delete process.env.ACCRETA_ROOT;
  delete process.env.ACCRETA_INDEX_PATH;
  output = [];
  errors = [];
  expect(await cli("init")).toBe(0);
  rmSync(join(root, "sources", "example.yaml"));
  output = [];
});

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

test("a 2.8 MB config.toml does not stall doctor (GHSA-r4xh-jqrq-34v2)", async () => {
  let text = "";
  for (let i = 0; i < 256_000; i++) text += `k${i} = 1\n`;
  write(join(root, ".codex", "config.toml"), text);
  const started = performance.now();
  await cli("doctor");
  // Quadratic parsing took about 6.5 s on an M-series laptop; linear takes a fraction of one.
  expect(performance.now() - started).toBeLessThan(2_000);
}, 30_000);

test("a PATH entry a package runner added does not count as the client's PATH", async () => {
  const added = [
    join(root, "node_modules", ".bin"),
    join(home, ".npm", "_npx", "abc", "node_modules", ".bin"),
    join(home, "tmp", "bun-node-abc"),
  ];
  for (const dir of added) {
    accretaIn(dir);
    output = [];
    errors = [];
    const config = { mcpServers: { accreta: { command: "accreta", args: ["mcp"] } } };
    write(join(root, ".mcp.json"), JSON.stringify(config));
    expect(await cli("doctor")).toBe(1);
    expect(stdout()).toContain("which is not on this shell's PATH");
    rmSync(join(root, ".mcp.json"));
    expect(await cli("mcp", "install", "--client", "claude")).toBe(0);
    expect(stderr()).toContain("npx -y accreta mcp");
    rmSync(join(root, ".mcp.json"));
    rmSync(join(dir, "accreta"));
  }
});

test("install does not warn when accreta is on PATH", async () => {
  accretaIn(join(home, "bin"));
  expect(await cli("mcp", "install", "--client", "claude")).toBe(0);
  expect(stderr()).toBe("");
});

test("a project-scope target reached through a symlink is refused", async () => {
  const outside = join(home, "outside");
  write(join(outside, "target.json"), "{}\n");
  symlinkSync(join(outside, "target.json"), join(root, ".mcp.json"));
  symlinkSync(outside, join(root, ".cursor"));
  symlinkSync(outside, join(root, ".codex"));
  for (const client of ["claude", "cursor", "codex"]) {
    errors = [];
    expect(await cli("mcp", "install", "--client", client)).toBe(1);
    expect(stderr()).toContain("symlink");
  }
  expect(readFileSync(join(outside, "target.json"), "utf-8")).toBe("{}\n");
  expect(existsSync(join(outside, "mcp.json"))).toBe(false);
  expect(existsSync(join(outside, "config.toml"))).toBe(false);
});

test("a user-scope symlink to a real file is written through, keeping its mode", async () => {
  const real = join(home, "dotfiles", "mcp.json");
  write(real, "{}\n");
  chmodSync(real, 0o600);
  mkdirSync(join(home, ".cursor"));
  symlinkSync(real, join(home, ".cursor", "mcp.json"));
  expect(await cli("mcp", "install", "--client", "cursor", "--scope", "user")).toBe(0);
  expect(lstatSync(join(home, ".cursor", "mcp.json")).isSymbolicLink()).toBe(true);
  expect(json(real).mcpServers.accreta.command).toBe("accreta");
  expect(statSync(real).mode & 0o777).toBe(0o600);
});

test("the file is replaced by a rename, never truncated in place", async () => {
  const path = join(root, ".mcp.json");
  write(path, "{}\n");
  const before = statSync(path).ino;
  expect(await cli("mcp", "install", "--client", "claude")).toBe(0);
  expect(statSync(path).ino).not.toBe(before);
  expect(readdirSync(root).filter((name) => name.includes(".tmp"))).toEqual([]);
});

test("doctor's ok is only for forms that cannot run something else", async () => {
  accretaIn(join(home, "bin"));
  executableAt(join(home, "bin", "npx"));
  executableAt(join(home, "bin", "bunx"));
  executableAt(join(root, "bin", "accreta"));
  const unknown: Record<string, [string, string[]]> = {
    a: ["npx", ["accreta@npm:left-pad", "mcp"]],
    b: ["npx", ["--package=evil", "accreta", "mcp"]],
    c: ["npx", ["-p", "evil", "accreta", "mcp"]],
    d: ["bunx", ["accreta@github:x/y", "mcp"]],
    e: ["./bin/accreta", ["mcp"]],
    f: [join(root, "bin", "accreta"), ["mcp"]],
  };
  const ok: Record<string, [string, string[]]> = {
    g: ["accreta", ["mcp"]],
    h: ["npx", ["-y", "accreta", "mcp"]],
    i: ["npx", ["-y", "accreta@0.2.0", "mcp"]],
    j: ["npx", ["-y", "accreta@latest", "mcp"]],
    k: ["bunx", ["--bun", "accreta@^0.2", "mcp"]],
    l: [join(home, "bin", "accreta"), ["mcp"]],
  };
  const servers = Object.fromEntries(
    Object.entries({ ...unknown, ...ok }).map(([key, [command, args]]) => [
      `accreta-${key}`,
      { command, args },
    ]),
  );
  write(join(root, ".mcp.json"), JSON.stringify({ mcpServers: servers }));
  await cli("doctor");
  for (const key of Object.keys(unknown)) {
    expect(stdout()).toMatch(new RegExp(`unknown: [^\\n]*\`accreta-${key}\``));
  }
  for (const key of Object.keys(ok)) {
    expect(stdout()).toMatch(new RegExp(`ok: [^\\n]*\`accreta-${key}\``));
  }
});

test("doctor escapes control characters from a config file", async () => {
  accretaIn(join(home, "bin"));
  const esc = "\u001b]0;x\u0007\u001b[2K\r  ok: fake\u009b\u007f";
  const entry = { command: `accreta${esc}`, args: [esc], env: { ACCRETA_ROOT: `/x${esc}` } };
  write(join(root, ".mcp.json"), JSON.stringify({ mcpServers: { [`accreta${esc}`]: entry } }));
  write(join(home, ".cursor", "mcp.json"), `{"mcpServers": {"a\u001b[2K": 1}`);
  await cli("doctor");
  // Newlines are doctor's own; any other control character came from the file.
  const controls = [...output.join("")].filter((c) => c !== "\n" && isControl(c.charCodeAt(0)));
  expect(controls).toEqual([]);
  expect(stdout()).toContain("\\u001b");
});

test("--force on TOML keeps the comment and blank lines before the next table", async () => {
  const path = join(root, ".codex", "config.toml");
  const after = `\n# the next server\n[mcp_servers.other]\ncommand = "o"\n`;
  write(path, `[mcp_servers.accreta]\ncommand = "node"\n${after}`);
  expect(await cli("mcp", "install", "--client", "codex", "--force")).toBe(0);
  expect(readFileSync(path, "utf-8")).toBe(
    `[mcp_servers.accreta]\ncommand = "accreta"\nargs = [ "mcp" ]\n${after}`,
  );
});

test("doctor reads Cursor's file as JSONC; install still refuses to rewrite it", async () => {
  accretaIn(join(home, "bin"));
  const text = `{\n  // mine\n  "mcpServers": { "accreta": { "command": "accreta", "args": ["mcp"] } }\n}\n`;
  write(join(root, ".cursor", "mcp.json"), text);
  expect(await cli("doctor")).toBe(0);
  expect(stdout()).toContain("ok: .cursor/mcp.json (Cursor, project)");
  expect(await cli("mcp", "install", "--client", "cursor", "--force")).toBe(1);
  expect(readFileSync(join(root, ".cursor", "mcp.json"), "utf-8")).toBe(text);
});

test("doctor reads Claude Code's local scope, under CLAUDE_CONFIG_DIR when set", async () => {
  accretaIn(join(home, "bin"));
  process.env.CLAUDE_CONFIG_DIR = join(home, "claude");
  const stale = { command: "bun", args: ["run", "node_modules/@accreta/mcp-server/src/main.ts"] };
  write(
    join(home, "claude", ".claude.json"),
    JSON.stringify({ projects: { [root]: { mcpServers: { accreta: stale } } } }),
  );
  expect(await cli("doctor")).toBe(1);
  expect(stdout()).toContain("stale: ~/claude/.claude.json (Claude Code, local) `accreta`");
  expect(stdout()).toContain("claude mcp remove --scope local accreta");
});

test("a JSON rewrite keeps the file's indent", async () => {
  for (const indent of ["    ", "\t"]) {
    const path = join(root, ".mcp.json");
    write(path, `${JSON.stringify({ mcpServers: { other: { command: "o" } } }, null, indent)}\n`);
    expect(await cli("mcp", "install", "--client", "claude")).toBe(0);
    const text = readFileSync(path, "utf-8");
    expect(text).toBe(`${JSON.stringify(JSON.parse(text), null, indent)}\n`);
    expect(text).toContain(`\n${indent}"mcpServers"`);
  }
});

test("a top-level inline mcp_servers is named as such", async () => {
  write(join(root, ".codex", "config.toml"), `mcp_servers = { other = { command = "o" } }\n`);
  expect(await cli("mcp", "install", "--client", "codex")).toBe(1);
  expect(stderr()).toContain("`mcp_servers` is an inline table");
});

test("on Windows the JSON to paste is printed, not a POSIX-quoted command", async () => {
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { value: "win32" });
  try {
    expect(await cli("mcp", "install", "--client", "claude", "--scope", "user")).toBe(0);
  } finally {
    Object.defineProperty(process, "platform", platform);
  }
  expect(stdout()).not.toContain(" '{");
  expect(stdout()).toContain("claude mcp add-json --scope user accreta");
  expect(stdout()).toContain(`{"type":"stdio","command":"accreta","args":["mcp"]`);
});

test("the --json description lines up with the others", async () => {
  expect(await cli("--help")).toBe(0);
  expect(stdout()).toContain("\n  --json                   On lint");
});
