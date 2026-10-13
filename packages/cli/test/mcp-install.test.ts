import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { run } from "../src/main.ts";
import { stripJsonc, targetFor } from "../src/commands/mcp-config.ts";
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
const toml = (path: string) => parseToml(readFileSync(path, "utf-8")) as Record<string, any>;
function write(path: string, text: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, "utf-8");
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "accreta-mcp-install-"));
  home = mkdtempSync(join(tmpdir(), "accreta-mcp-home-"));
  for (const key of ENV) if (key !== "PATH") delete process.env[key];
  process.env.HOME = home;
  delete process.env.ACCRETA_ROOT;
  delete process.env.ACCRETA_INDEX_PATH;
  output = [];
  errors = [];
  expect(await cli("init")).toBe(0);
  // The example points at a directory init does not create, which doctor rightly fails on.
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

describe("accreta mcp install writes each client's file", () => {
  test("claude, project: .mcp.json, started in the knowledge base", async () => {
    expect(await cli("mcp", "install", "--client", "claude")).toBe(0);
    expect(json(join(root, ".mcp.json"))).toEqual({
      mcpServers: { accreta: { type: "stdio", command: "accreta", args: ["mcp"] } },
    });
  });

  test("cursor, project: .cursor/mcp.json, rooted at ${workspaceFolder}", async () => {
    expect(await cli("mcp", "install", "--client", "cursor", "--scope", "project")).toBe(0);
    expect(json(join(root, ".cursor", "mcp.json")).mcpServers.accreta).toEqual({
      type: "stdio",
      command: "accreta",
      args: ["mcp"],
      env: { ACCRETA_ROOT: "${workspaceFolder}" },
    });
  });

  test("cursor, user: ~/.cursor/mcp.json names this knowledge base", async () => {
    expect(await cli("mcp", "install", "--client=cursor", "--scope=user")).toBe(0);
    expect(json(join(home, ".cursor", "mcp.json")).mcpServers.accreta.env).toEqual({
      ACCRETA_ROOT: root,
    });
    expect(existsSync(join(root, ".cursor"))).toBe(false);
  });

  test("codex, project: .codex/config.toml, and a word about trust", async () => {
    const code = await cli("mcp", "install", "--client", "codex");
    expect(stderr()).not.toContain("does not parse");
    expect(code).toBe(0);
    expect(toml(join(root, ".codex", "config.toml"))).toEqual({
      mcp_servers: { accreta: { command: "accreta", args: ["mcp"] } },
    });
    expect(stdout()).toContain("trust the project");
  });

  test("codex, user: ~/.codex/config.toml with the knowledge base as cwd", async () => {
    expect(await cli("mcp", "install", "--client", "codex", "--scope", "user")).toBe(0);
    expect(toml(join(home, ".codex", "config.toml")).mcp_servers.accreta).toEqual({
      command: "accreta",
      args: ["mcp"],
      cwd: root,
    });
  });

  test("codex, user: CODEX_HOME moves the file", async () => {
    process.env.CODEX_HOME = join(home, "elsewhere");
    expect(await cli("mcp", "install", "--client", "codex", "--scope", "user")).toBe(0);
    expect(existsSync(join(home, "elsewhere", "config.toml"))).toBe(true);
  });

  test("vscode, project: .vscode/mcp.json under `servers`, cwd ${workspaceFolder}", async () => {
    expect(await cli("mcp", "install", "--client", "vscode")).toBe(0);
    expect(json(join(root, ".vscode", "mcp.json"))).toEqual({
      servers: {
        accreta: { type: "stdio", command: "accreta", args: ["mcp"], cwd: "${workspaceFolder}" },
      },
    });
  });

  test("claude and vscode, user: the client's own command is printed, nothing written", async () => {
    expect(await cli("mcp", "install", "--client", "claude", "--scope", "user")).toBe(0);
    expect(stdout()).toContain("claude mcp add-json --scope user accreta '");
    expect(stdout()).toContain(`"ACCRETA_ROOT":"${root}"`);
    expect(existsSync(join(home, ".claude.json"))).toBe(false);

    output = [];
    expect(await cli("mcp", "install", "--client", "vscode", "--scope", "user")).toBe(0);
    expect(stdout()).toContain(`code --add-mcp '{"name":"accreta","type":"stdio"`);
    expect(stdout()).toContain(`"cwd":"${root}"`);
  });

  test("a user-scope entry the client already has is reported, not printed again", async () => {
    const target = targetFor("claude", "user", root);
    write(target.path, JSON.stringify({ mcpServers: { accreta: target.entry } }));
    expect(await cli("mcp", "install", "--client", "claude", "--scope", "user")).toBe(0);
    expect(stdout()).toContain("Nothing to do");
    expect(stdout()).not.toContain("add-json");
  });
});

describe("accreta mcp install merges, and refuses what it cannot merge", () => {
  test("other servers in a JSON file are kept", async () => {
    const path = join(root, ".mcp.json");
    const other = { command: "other", args: ["--flag"], env: { KEY: "value" } };
    write(path, JSON.stringify({ mcpServers: { other }, extra: true }));
    expect(await cli("mcp", "install", "--client", "claude")).toBe(0);
    expect(json(path).mcpServers.other).toEqual(other);
    expect(json(path).extra).toBe(true);
    expect(Object.keys(json(path).mcpServers)).toEqual(["other", "accreta"]);
  });

  test("a TOML file keeps every byte it had, comments included", async () => {
    const path = join(home, ".codex", "config.toml");
    const before = `# my settings\nmodel = "x" # inline\n\n[mcp_servers.other]\ncommand = "other"\n`;
    write(path, before);
    expect(await cli("mcp", "install", "--client", "codex", "--scope", "user")).toBe(0);
    const after = readFileSync(path, "utf-8");
    expect(after.startsWith(before)).toBe(true);
    expect(toml(path).mcp_servers.other).toEqual({ command: "other" });
  });

  test("installing twice is a no-op", async () => {
    for (const client of ["claude", "codex"]) {
      expect(await cli("mcp", "install", "--client", client)).toBe(0);
      const path = targetFor(client as "claude" | "codex", "project", root).path;
      const first = readFileSync(path, "utf-8");
      output = [];
      expect(await cli("mcp", "install", "--client", client)).toBe(0);
      expect(stdout()).toContain("Nothing to do");
      expect(readFileSync(path, "utf-8")).toBe(first);
    }
  });

  test("an accreta entry that differs is reported, and replaced only with --force", async () => {
    const path = join(root, ".mcp.json");
    const stale = { command: "bun", args: ["run", "node_modules/@accreta/mcp-server/src/main.ts"] };
    write(path, JSON.stringify({ mcpServers: { accreta: stale, other: { command: "o" } } }));
    const original = readFileSync(path, "utf-8");

    expect(await cli("mcp", "install", "--client", "claude")).toBe(1);
    expect(stderr()).toContain("already has an `accreta` server that differs");
    expect(stderr()).toContain("--force");
    expect(readFileSync(path, "utf-8")).toBe(original);

    expect(await cli("mcp", "install", "--client", "claude", "--force")).toBe(0);
    expect(json(path).mcpServers).toEqual({
      accreta: { type: "stdio", command: "accreta", args: ["mcp"] },
      other: { command: "o" },
    });
  });

  test("--force replaces a TOML table in place and keeps the tables after it", async () => {
    const path = join(root, ".codex", "config.toml");
    write(
      path,
      `top = 1\n\n[mcp_servers.accreta]\ncommand = "node"\nargs = ["old.js"]\n\n[mcp_servers.accreta.env]\nA = "b"\n\n[mcp_servers.other]\ncommand = "o"\n`,
    );
    expect(await cli("mcp", "install", "--client", "codex")).toBe(1);
    expect(await cli("mcp", "install", "--client", "codex", "--force")).toBe(0);
    expect(toml(path)).toEqual({
      top: 1,
      mcp_servers: { accreta: { command: "accreta", args: ["mcp"] }, other: { command: "o" } },
    });
  });

  test("an accreta entry TOML defines inline is left for a human, even with --force", async () => {
    const path = join(root, ".codex", "config.toml");
    const text = `mcp_servers = { accreta = { command = "node" } }\n`;
    write(path, text);
    expect(await cli("mcp", "install", "--client", "codex", "--force")).toBe(1);
    expect(stderr()).toContain("is an inline table");
    expect(readFileSync(path, "utf-8")).toBe(text);
  });

  test("an accreta entry inside a [mcp_servers] table is left for a human too", async () => {
    const path = join(root, ".codex", "config.toml");
    const text = `[mcp_servers]\naccreta = { command = "node" }\n`;
    write(path, text);
    expect(await cli("mcp", "install", "--client", "codex", "--force")).toBe(1);
    expect(stderr()).toContain("cannot edit safely");
    expect(readFileSync(path, "utf-8")).toBe(text);
  });

  test("a file that does not parse is refused and never rewritten", async () => {
    const cases = [
      [join(root, ".mcp.json"), "{ not json", "claude"],
      [join(root, ".cursor", "mcp.json"), "[]", "cursor"],
      [join(root, ".codex", "config.toml"), "[mcp_servers\ncommand =", "codex"],
      // VS Code reads JSONC; a rewrite would drop the comment, so it is not rewritten either.
      [join(root, ".vscode", "mcp.json"), `{\n  // mine\n  "servers": {}\n}\n`, "vscode"],
    ] as const;
    for (const [path, text, client] of cases) {
      write(path, text);
      errors = [];
      expect(await cli("mcp", "install", "--client", client)).toBe(1);
      expect(stderr()).toContain("does not parse");
      expect(stderr()).toContain("add this by hand");
      expect(readFileSync(path, "utf-8")).toBe(text);
    }
  });

  test("a missing or unknown client, or an install flag without install, is a usage error", async () => {
    expect(await cli("mcp", "install")).toBe(2);
    expect(stderr()).toContain("needs --client");
    expect(await cli("mcp", "install", "--client", "emacs")).toBe(2);
    expect(stderr()).toContain('not "emacs"');
    expect(await cli("mcp", "install", "--client", "claude", "--scope", "global")).toBe(2);
    expect(await cli("mcp", "--client", "claude")).toBe(2);
    expect(stderr()).toContain("go with `accreta mcp install`");
    expect(await cli("mcp", "install", "--client", "--force")).toBe(2);
    expect(stderr()).toContain("--client needs a value");
  });
});

test("init ends with the install command to run", async () => {
  const fresh = mkdtempSync(join(tmpdir(), "accreta-mcp-init-"));
  try {
    expect(await run(["init"], { ...ctx(), cwd: fresh })).toBe(0);
    expect(output.at(-1)).toBe(
      "To connect an agent: accreta mcp install --client <claude|cursor|codex|vscode>",
    );
  } finally {
    rmSync(fresh, { recursive: true, force: true });
  }
});

test("the top-level usage lists mcp and mcp install", async () => {
  expect(await cli("--help")).toBe(0);
  expect(stdout()).toContain("\n  mcp  ");
  expect(stdout()).toContain("mcp install --client <claude|cursor|codex|vscode>");
});

test("stripJsonc keeps strings that look like comments", () => {
  const text = `{ "a": "http://x//y", /* c */ "b": [1, 2,], // d\n }`;
  expect(JSON.parse(stripJsonc(text))).toEqual({ a: "http://x//y", b: [1, 2] });
});

describe("doctor reads what mcp install writes", () => {
  /** A PATH holding an `accreta` executable, so the configured command resolves. */
  function accretaOnPath() {
    const bin = join(home, "bin");
    write(join(bin, "accreta"), "#!/bin/sh\n");
    chmodSync(join(bin, "accreta"), 0o755);
    process.env.PATH = bin;
  }

  test("nothing configured is unknown, not a failure", async () => {
    expect(await cli("doctor")).toBe(0);
    expect(stdout()).toContain("unknown: no client config here or in your home directory");
  });

  test("an installed entry whose command resolves is ok, for project and user scope", async () => {
    accretaOnPath();
    expect(await cli("mcp", "install", "--client", "claude")).toBe(0);
    expect(await cli("mcp", "install", "--client", "codex", "--scope", "user")).toBe(0);
    output = [];
    expect(await cli("doctor")).toBe(0);
    expect(stdout()).toContain("ok: .mcp.json (Claude Code, project) `accreta` runs `accreta mcp`");
    expect(stdout()).toContain(
      "ok: ~/.codex/config.toml (Codex, user) `accreta` runs `accreta mcp`",
    );
    expect(stdout()).not.toContain("for the knowledge base at");
  });

  test("a user entry for another knowledge base says which", async () => {
    accretaOnPath();
    const other = join(home, "other-kb");
    write(
      join(home, ".cursor", "mcp.json"),
      JSON.stringify({
        mcpServers: {
          accreta: { command: "accreta", args: ["mcp"], env: { ACCRETA_ROOT: other } },
        },
      }),
    );
    expect(await cli("doctor")).toBe(0);
    expect(stdout()).toContain(`for the knowledge base at ${other}`);
  });

  test("the old server path is stale, with the fix", async () => {
    accretaOnPath();
    write(
      join(root, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          kb: { command: "bun", args: ["run", "node_modules/@accreta/mcp-server/src/main.ts"] },
        },
      }),
    );
    expect(await cli("doctor")).toBe(1);
    expect(stdout()).toContain("stale: .mcp.json (Claude Code, project) `kb` runs `bun run");
    expect(stdout()).toContain("re-run `accreta mcp install --client claude --force`");
  });

  test("a command that is not on PATH is broken", async () => {
    process.env.PATH = join(home, "empty");
    expect(await cli("mcp", "install", "--client", "vscode")).toBe(0);
    output = [];
    expect(await cli("doctor")).toBe(1);
    expect(stdout()).toContain(
      "broken: .vscode/mcp.json (VS Code, project) `accreta` runs `accreta`, which is not on this shell's PATH",
    );
  });

  test("a form doctor does not know is unknown, not a failure", async () => {
    accretaOnPath();
    write(
      join(root, ".mcp.json"),
      JSON.stringify({ mcpServers: { accreta: { command: "accreta", args: ["serve"] } } }),
    );
    expect(await cli("doctor")).toBe(0);
    expect(stdout()).toContain(
      "unknown: .mcp.json (Claude Code, project) `accreta` runs `accreta serve`",
    );
  });

  test("a config that does not parse is broken", async () => {
    write(join(root, ".codex", "config.toml"), "[mcp_servers\n");
    expect(await cli("doctor")).toBe(1);
    expect(stdout()).toContain("broken: .codex/config.toml (Codex, project) does not parse");
  });

  test("a VS Code file with comments is read as the JSONC it is", async () => {
    accretaOnPath();
    write(
      join(root, ".vscode", "mcp.json"),
      `{\n  // mine\n  "servers": { "accreta": { "type": "stdio", "command": "accreta", "args": ["mcp"], }, },\n}\n`,
    );
    expect(await cli("doctor")).toBe(0);
    expect(stdout()).toContain("ok: .vscode/mcp.json (VS Code, project)");
  });
});
