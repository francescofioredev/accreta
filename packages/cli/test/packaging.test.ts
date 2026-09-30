import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * A tarball holds only what `files` and `prepack` put in it, and the gap is
 * invisible until someone installs it — by then it is on npm, unrepublishable.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** In dependency order: a dependent installed before its dependency is broken. */
const PUBLISHABLE = [
  "packages/core",
  "packages/adapters/fs",
  "packages/adapters/git",
  "packages/adapters/delegated",
  "packages/adapters/registry",
  "packages/mcp-server",
  "packages/cli",
];

const UNSUPPORTED_MESSAGE = "accreta needs SQLite with FTS5: Node ^22.16.0 || >=24, or Bun >=1.4.0";

// A bin spawned directly obeys its `node` shebang, so each runtime is named explicitly (ADR-0016).
const RUNTIMES = [
  { name: "node", argv: ["node"] },
  { name: "bun --bun", argv: [process.execPath, "--bun"] },
];

// Node 22.12 has no node:sqlite and 22.14 no FTS5; CI names them, a local run may not.
const UNSUPPORTED = (process.env.ACCRETA_UNSUPPORTED_RUNTIMES ?? "")
  .split(delimiter)
  .filter(Boolean);

// Not safe to run concurrently with another copy of this suite: `prepack`
// copies the assets into packages/cli/ and `postpack` removes them again, so two
// runs racing each other see the directory appear and vanish underneath them.
// The temp dirs below are per-run; the package directory is not.
let staging = "";
let consumer = "";
let accreta = "";
let accretaMcp = "";

/** `accreta-core-0.1.1.tgz` is `@accreta/core`; `accreta-0.1.1.tgz` is `accreta`. */
function nameOf(tarball: string): string {
  const stem = tarball.replace(/-\d+\.\d+\.\d+\.tgz$/, "");
  return stem === "accreta" ? stem : `@accreta/${stem.replace(/^accreta-/, "")}`;
}

// A hook timeout SIGTERMs the child; say so, or it reads as the child's own failure.
function killedBy(result: { signalCode?: string }): string {
  return result.signalCode ? ` (killed by ${result.signalCode})` : "";
}

function exec(argv: string[], cwd: string) {
  const result = Bun.spawnSync(argv, { cwd, stdout: "pipe", stderr: "pipe" });
  return {
    code: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

function git(cwd: string, ...args: string[]): string {
  const result = exec(["git", ...args], cwd);
  if (result.code !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

/** A knowledge base with one page citing two lines of a git source, verified at HEAD. */
function gitProject(): { dir: string; revision: string } {
  const dir = mkdtempSync(join(tmpdir(), "accreta-project-"));
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "user.name", "Test");
  git(dir, "config", "commit.gpgsign", "false");
  mkdirSync(join(dir, "docs"));
  writeFileSync(join(dir, "docs", "a.md"), "albedo is reflectivity\nsecond line\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "first");
  const revision = git(dir, "rev-parse", "HEAD");

  mkdirSync(join(dir, "sources"));
  writeFileSync(join(dir, "sources", "repo.yaml"), "id: repo\ntype: git\nroot: .\npaths: [docs]\n");
  mkdirSync(join(dir, "knowledge"));
  writeFileSync(
    join(dir, "knowledge", "albedo.md"),
    `---\ntype: concept\nsource: repo\ncanonical_source: "repo:docs/a.md#L1"\n` +
      `last_verified_revision: ${revision}\n---\n\n` +
      `# Albedo\n\nThe fraction of light a surface reflects.[^a]\n\n` +
      `[^a]: repo @ ${revision} · docs/a.md#L1-L2\n`,
  );
  return { dir, revision };
}

/** MCP initialize and tools/list over stdio, with stdin closed after them as a client would. */
async function handshake(argv: string[], cwd: string) {
  const server = Bun.spawn(argv, { cwd, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const messages = [
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "packaging-test", version: "0.0.0" },
      },
    },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
  ];
  server.stdin.write(messages.map((message) => `${JSON.stringify(message)}\n`).join(""));
  await server.stdin.flush();
  server.stdin.end();

  const [stdout, stderr, code] = await Promise.all([
    new Response(server.stdout).text(),
    new Response(server.stderr).text(),
    server.exited,
  ]);
  const responses = stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { id: number; result: Record<string, unknown> });
  return { code, stderr, responses };
}

beforeAll(() => {
  staging = mkdtempSync(join(tmpdir(), "accreta-staging-"));
  consumer = mkdtempSync(join(tmpdir(), "accreta-consumer-"));

  for (const pkg of PUBLISHABLE) {
    // `bun pm pack` runs prepack, which builds dist/ and copies the templates in.
    const packed = Bun.spawnSync([process.execPath, "pm", "pack", "--destination", staging], {
      cwd: join(REPO_ROOT, pkg),
      stderr: "pipe",
    });
    if (packed.exitCode !== 0) {
      throw new Error(`packing ${pkg} failed${killedBy(packed)}:\n${packed.stderr.toString()}`);
    }
  }

  const tarballs = readdirSync(staging).filter((name) => name.endsWith(".tgz"));
  expect(tarballs).toHaveLength(PUBLISHABLE.length);

  // Every tarball depends on the others by version, and those versions are not
  // on the registry yet — the first publish is what puts them there. `overrides`
  // points those dependencies back at the local files, so the packed artifacts
  // satisfy each other and what gets exercised is still the packed layout.
  const specifiers = Object.fromEntries(tarballs.map((name) => [nameOf(name), `file:./${name}`]));
  writeFileSync(
    join(consumer, "package.json"),
    JSON.stringify({
      name: "consumer",
      version: "0.0.0",
      private: true,
      dependencies: specifiers,
      overrides: specifiers,
    }),
    "utf-8",
  );
  for (const name of tarballs) {
    cpSync(join(staging, name), join(consumer, name));
  }

  const install = Bun.spawnSync([process.execPath, "install"], { cwd: consumer, stderr: "pipe" });
  if (install.exitCode !== 0) {
    throw new Error(
      `installing the tarballs failed${killedBy(install)}:\n${install.stderr.toString()}`,
    );
  }

  accreta = join(consumer, "node_modules", ".bin", "accreta");
  accretaMcp = join(consumer, "node_modules", ".bin", "accreta-mcp");
  // Seven packs and an install that may hit the network: bun's 5s default killed it under load.
}, 120_000);

afterAll(() => {
  for (const dir of [staging, consumer]) {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

test("the CLI is installed under the name it publishes as", () => {
  expect(existsSync(accreta)).toBe(true);
  expect(existsSync(accretaMcp)).toBe(true);
});

test("packing leaves no dist/ behind for a run without the source condition to pick up", () => {
  for (const pkg of PUBLISHABLE)
    expect(`${pkg}: ${existsSync(join(REPO_ROOT, pkg, "dist"))}`).toBe(`${pkg}: false`);
});

test("an installed package ships its build and not its sources", () => {
  const core = join(consumer, "node_modules", "@accreta", "core");
  expect(existsSync(join(core, "dist", "index.js"))).toBe(true);
  expect(existsSync(join(core, "dist", "index.d.ts"))).toBe(true);
  expect(existsSync(join(core, "src"))).toBe(false);
});

test("an installed core carries the schema its index is built from", () => {
  // tsc copies no .sql; a build that forgot it would fail every reindex on a user's machine.
  const schema = join(
    consumer,
    "node_modules",
    "@accreta",
    "core",
    "dist",
    "index-db",
    "schema.sql",
  );
  expect(existsSync(schema)).toBe(true);
});

test("an installed CLI carries its own constitution templates", () => {
  // The project directory is under tmpdir(), never inside the repository. Were
  // it inside, the resolver's repo-root fallback would find the real templates
  // and this test would pass against a package that ships none of them — which
  // is precisely the bug it exists to catch.
  const project = mkdtempSync(join(tmpdir(), "accreta-project-"));
  try {
    const init = exec(["node", accreta, "init", "--preset", "research"], project);
    expect(init.stderr + init.stdout).not.toContain("template not found");
    expect(init.code).toBe(0);

    // Not merely that init exited zero: it writes the config before the
    // constitution, so a missing template still leaves a half-finished run.
    const agents = readFileSync(join(project, "AGENTS.md"), "utf-8");
    expect(agents).toContain("composed from: base.md + presets/research.md");
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("an installed CLI carries the setup skill, and its declared floor", () => {
  // The README sends a user to `npx skills add`, which installs from git. The
  // package ships its own copy anyway, version-locked to the code beside it —
  // and no command reads it, so `skills` dropping out of `files`, or prepack
  // failing to copy it, would be invisible to every other test here.
  const skill = join(consumer, "node_modules", "accreta", "skills", "accreta-setup", "SKILL.md");
  expect(existsSync(skill)).toBe(true);

  const text = readFileSync(skill, "utf-8");
  expect(text).toContain("name: accreta-setup");
  expect(text).toMatch(/^\s+requires:/m);
});

describe.each(RUNTIMES)("the installed bins under $name", ({ argv }) => {
  let dir = "";
  let revision = "";
  const cli = (...args: string[]) => exec([...argv, accreta, ...args], dir);

  beforeAll(() => {
    ({ dir, revision } = gitProject());
  });

  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  // Exit 0 alone proved nothing: on Node 22.16 a guarded main.ts printed nothing and exited 0.
  // Empty stderr is the warning filter running before node:sqlite is linked.
  test("init, reindex, search, lint and drift each do their work, with nothing on stderr", () => {
    const init = cli("init");
    expect(init).toMatchObject({ code: 0, stderr: "" });

    const reindex = cli("reindex");
    expect(reindex).toMatchObject({ code: 0, stderr: "" });
    expect(existsSync(join(dir, ".accreta", "index.sqlite"))).toBe(true);

    const search = cli("search", "reflects", "--json");
    expect(search).toMatchObject({ code: 0, stderr: "" });
    expect(search.stdout).toContain("knowledge/albedo.md");

    const lint = cli("lint");
    expect(lint).toMatchObject({ code: 0, stderr: "" });
    expect(lint.stdout).toContain("1 page(s) checked, nothing to report.\n2 citation(s) checked");

    const clean = cli("drift");
    expect(clean).toMatchObject({ code: 0, stderr: "" });
    expect(clean.stdout).toContain(`repo @ ${revision}`);

    writeFileSync(join(dir, "docs", "a.md"), "albedo is changed\nsecond line\n");
    git(dir, "commit", "-q", "-am", "edit a cited line");
    const stale = cli("drift");
    expect(stale).toMatchObject({ code: 1, stderr: "" });
    expect(stale.stdout).toContain("knowledge/albedo.md");
  }, 30_000);

  test.each([
    ["accreta-mcp", () => [...argv, accretaMcp]],
    ["accreta mcp", () => [...argv, accreta, "mcp"]],
  ])(
    "%s answers initialize and tools/list",
    async (_, command) => {
      const installed = JSON.parse(
        readFileSync(
          join(consumer, "node_modules", "@accreta", "mcp-server", "package.json"),
          "utf-8",
        ),
      ) as { version: string };

      const { code, stderr, responses } = await handshake(command(), dir);
      expect(stderr).not.toContain("ExperimentalWarning");
      expect(code).toBe(0);
      const [initialize, list] = responses;
      expect(initialize?.result.serverInfo).toEqual({
        name: "accreta",
        version: installed.version,
      });
      const tools = ((list?.result.tools ?? []) as { name: string }[]).map((tool) => tool.name);
      expect(tools).toContain("search_pages");
    },
    15_000,
  );

  test("a write through a read-only open is refused by the installed core", () => {
    // In the consumer, so @accreta/core resolves to the installed package.
    const script = join(consumer, "read-only.mjs");
    writeFileSync(
      script,
      `import { openIndex } from "@accreta/core";\n` +
        `const db = openIndex(process.argv[2], { readonly: true });\n` +
        `try { db.exec("DELETE FROM pages"); console.log("written"); }\n` +
        `catch (error) { console.log("refused: " + error.message); }\n`,
    );
    const result = exec([...argv, script, join(dir, ".accreta", "index.sqlite")], consumer);
    expect(result.stdout.trim()).toBe("refused: attempt to write a readonly database");
  });
});

if (UNSUPPORTED.length === 0) {
  test.skip("unsupported runtimes are refused (set ACCRETA_UNSUPPORTED_RUNTIMES)", () => {});
}

describe.each(UNSUPPORTED)("the installed bins under %s", (runtime) => {
  let dir = "";

  beforeAll(() => {
    ({ dir } = gitProject());
    // Built by a supported runtime, so the unsupported one is refused at the open, not before.
    exec(["node", accreta, "init"], dir);
    exec(["node", accreta, "reindex"], dir);
  });

  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  test.each([
    ["accreta reindex", () => [runtime, accreta, "reindex"]],
    ["accreta search", () => [runtime, accreta, "search", "albedo"]],
    ["accreta-mcp", () => [runtime, accretaMcp]],
  ])("%s names the supported range and exits non-zero", (_, command) => {
    const result = exec(command(), dir);
    expect(result.stderr).toContain(UNSUPPORTED_MESSAGE);
    expect(result.code).toBe(1);
  });
});

test("the published manifests name real versions, not workspace protocols", () => {
  // npm publishes, and unlike bun it copies `workspace:*` into the tarball
  // verbatim. Such a package installs for nobody and cannot be republished, so
  // the protocol must never reach a manifest in the first place.
  for (const pkg of PUBLISHABLE) {
    const manifest = JSON.parse(readFileSync(join(REPO_ROOT, pkg, "package.json"), "utf-8")) as {
      dependencies?: Record<string, string>;
    };

    for (const [name, range] of Object.entries(manifest.dependencies ?? {})) {
      expect(`${pkg} → ${name}: ${range}`).not.toContain("workspace:");
    }
  }
});
