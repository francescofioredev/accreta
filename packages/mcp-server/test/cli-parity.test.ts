import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
// Relative on purpose: neither package depends on the other, and this test is the bridge.
import { run } from "../../cli/src/main.ts";
import { createContext, createServer, type ToolContext } from "../src/index.ts";

// The CLI command that answers the same question as each MCP tool.
const CLI_TWIN: Record<string, string> = {
  search_pages: "search",
  get_page: "show",
  find_consumers: "consumers",
  find_canonical: "canonical",
  lint_knowledge_base: "lint",
  check_drift: "drift",
};

// Twins whose `--json` is another issue's work, so their shape is not compared yet.
const JSON_PENDING: Record<string, string> = {
  check_drift: "drift --json reports what a change put in doubt, not check_drift's shape",
};

// Tools with no CLI command yet. Each entry is owed a command, not a reason to stay here.
const NO_TWIN_YET: Record<string, string> = {
  list_recent_changes: "a new read command, not an output format; out of scope for #128",
  update_verified_revision:
    "the only write tool; how the CLI gates a provenance write is undecided",
};

interface Case {
  tool: string;
  args: Record<string, unknown>;
  argv: string[];
  code: number;
}

const CASES: Case[] = [
  { tool: "search_pages", args: { query: "tropopause" }, argv: ["search", "tropopause"], code: 0 },
  { tool: "search_pages", args: { query: "RF" }, argv: ["search", "RF"], code: 0 },
  {
    tool: "search_pages",
    args: { query: "flux", types: ["concept"], source: "docs", limit: 1 },
    argv: ["search", "flux", "--type", "concept", "--source", "docs", "--limit", "1"],
    code: 0,
  },
  {
    tool: "search_pages",
    args: { query: "flux", limit: 1 },
    argv: ["search", "flux", "--limit=1"],
    code: 0,
  },
  {
    tool: "search_pages",
    args: { query: "nothingmatches" },
    argv: ["search", "nothingmatches"],
    code: 0,
  },
  {
    tool: "get_page",
    args: { path: "concepts/forcing" },
    argv: ["show", "concepts/forcing"],
    code: 0,
  },
  {
    tool: "get_page",
    args: { path: "concepts/nothing" },
    argv: ["show", "concepts/nothing"],
    code: 1,
  },
  {
    tool: "find_consumers",
    args: { target: "concepts/forcing" },
    argv: ["consumers", "concepts/forcing"],
    code: 0,
  },
  {
    tool: "find_consumers",
    args: { target: "concepts/forcing", include_inline: true },
    argv: ["consumers", "concepts/forcing", "--inline"],
    code: 0,
  },
  {
    tool: "find_consumers",
    args: { target: "concepts/forcing", include_inline: true, kinds: ["related"] },
    argv: ["consumers", "concepts/forcing", "--inline", "--kind", "related"],
    code: 0,
  },
  { tool: "find_consumers", args: { target: "missing" }, argv: ["consumers", "missing"], code: 0 },
  { tool: "find_canonical", args: { term: "RF" }, argv: ["canonical", "RF"], code: 0 },
  {
    tool: "find_canonical",
    args: { term: "-O2" },
    argv: ["canonical", "--", "-O2"],
    code: 0,
  },
  { tool: "find_canonical", args: { term: "nothing" }, argv: ["canonical", "nothing"], code: 0 },
  { tool: "lint_knowledge_base", args: {}, argv: ["lint"], code: 1 },
];

// Each would once have been ignored or misread, and answered as if it had run.
const REFUSED: { argv: string[]; says: string }[] = [
  { argv: ["search", "flux", "--source", "--json"], says: "--source needs a value" },
  { argv: ["search", "flux", "--limit"], says: "--limit needs a value" },
  { argv: ["search", "flux", "--limit="], says: "--limit needs a value" },
  { argv: ["search", "flux", "--limit", "51"], says: "--limit" },
  { argv: ["search", "flux", "--bogus"], says: "search does not take --bogus" },
  { argv: ["lint", "--json=yes"], says: "--json takes no value" },
  { argv: ["drift", "--source", "nope"], says: "drift does not take --source" },
  { argv: ["canonical", "RF", "--limit", "1"], says: "canonical does not take --limit" },
  { argv: ["show", "concepts/forcing", "--source", "docs"], says: "show does not take --source" },
  { argv: ["show", "concepts/forcing", "notes/b"], says: 'show does not take "notes/b"' },
  { argv: ["consumers", "concepts/forcing", "--kind"], says: "--kind needs a value" },
  { argv: ["reindex", "--json"], says: "reindex does not take --json" },
  { argv: ["search"], says: "Usage" },
  { argv: ["nosuch"], says: "Unknown command" },
  { argv: ["nosuch", "--help"], says: "Unknown command" },
  { argv: ["canonical", "--", "-O2", "--json"], says: "options go before --" },
  { argv: ["search", "flux", "--limit", "0"], says: "--limit" },
  { argv: ["search", "flux", "--limit", "2.5"], says: "--limit" },
  { argv: ["canonical", "-O2"], says: "Put -- before" },
  { argv: ["source", "add", "fs", "x", "--set", "novalue"], says: "--set takes key=value" },
  { argv: ["source", "add", "nosuchtype", "x"], says: "Unknown source type" },
  { argv: ["source", "remove", "docs"], says: "Usage: accreta source add" },
];

let root = "";
let ctx: ToolContext;
let client: Client;

function write(relativePath: string, contents: string): void {
  const full = join(root, relativePath);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, contents, "utf-8");
}

async function cli(argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(argv, {
    cwd: root,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  });
  return { code, stdout: out.join("\n"), stderr: err.join("\n") };
}

async function mcp(tool: string, args: Record<string, unknown>) {
  const result = (await client.callTool({ name: tool, arguments: args })) as {
    content: { text: string }[];
    isError?: boolean;
  };
  return { text: result.content[0]?.text ?? "", isError: result.isError === true };
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "accreta-parity-"));
  delete process.env.ACCRETA_ROOT;
  delete process.env.ACCRETA_INDEX_PATH;
  process.env.ACCRETA_ALLOW_WRITES = "1";

  write(
    "accreta.config.yaml",
    "knowledge_base: knowledge\npage_types: [concept, note]\nlink_fields: [related]\n",
  );
  write("sources/docs.yaml", "id: docs\ntype: fs\nroot: src-docs\n");
  write("sources/typo.yaml", "id: typo\ntype: fss\n");
  write("src-docs/forcing.md", "one\ntwo\nthree\n");
  write(
    "knowledge/concepts/forcing.md",
    '---\ntype: concept\nsource: docs\naliases: [RF, radiative forcing, "-O2"]\n' +
      'canonical_source: "docs:forcing.md#L2"\nlast_verified_revision: r1\n' +
      "related: [[notes/odd]]\n---\n\n" +
      "# Radiative forcing\n\nTropopause flux.\n",
  );
  write(
    "knowledge/notes/b.md",
    "---\ntype: note\nrelated: [[concepts/forcing]]\n---\n\n# B\n\n" +
      "Flux again, per [[concepts/forcing]] and [[missing]].\n",
  );
  write("knowledge/notes/odd.md", "---\ntype: gadget\n---\n\n# Odd\n");
  expect((await cli(["reindex"])).code).toBe(0);

  ctx = createContext(root);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "parity-probe", version: "0.0.0" });
  await Promise.all([createServer(ctx).connect(serverTransport), client.connect(clientTransport)]);
});

afterAll(async () => {
  await client?.close();
  ctx?.db.close();
  delete process.env.ACCRETA_ALLOW_WRITES;
  rmSync(root, { recursive: true, force: true });
});

describe("every MCP tool has a CLI twin", () => {
  test("each tool the server registers is paired or explicitly owed one", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name);
    expect(names).toContain("update_verified_revision");

    const unpaired = names.filter((name) => !(name in CLI_TWIN) && !(name in NO_TWIN_YET));
    expect(unpaired).toEqual([]);

    const stale = [...Object.keys(CLI_TWIN), ...Object.keys(NO_TWIN_YET)].filter(
      (name) => !names.includes(name),
    );
    expect(stale).toEqual([]);
  });

  test("each twin is a command the CLI knows", async () => {
    for (const command of Object.values(CLI_TWIN)) {
      const { stderr } = await cli([command]);
      expect(stderr).not.toContain("Unknown command");
    }
  });

  test("each twin with --json has a case comparing it", () => {
    const covered = new Set(CASES.map((c) => c.tool));
    const missing = Object.keys(CLI_TWIN).filter(
      (tool) => !(tool in JSON_PENDING) && !covered.has(tool),
    );
    expect(missing).toEqual([]);
  });
});

describe("--json matches the MCP tool field for field", () => {
  for (const c of CASES) {
    test(`${c.argv.join(" ")} --json = ${c.tool} ${JSON.stringify(c.args)}`, async () => {
      const [fromCli, fromMcp] = [
        await cli(
          c.argv.includes("--")
            ? [c.argv[0]!, "--json", ...c.argv.slice(1)]
            : [...c.argv, "--json"],
        ),
        await mcp(c.tool, c.args),
      ];
      expect(fromMcp.isError).toBe(false);
      expect(fromCli.code).toBe(c.code);
      expect(JSON.parse(fromCli.stdout)).toStrictEqual(JSON.parse(fromMcp.text));
    });
  }

  // Fixture guard: a case that compared two empty answers would prove nothing.
  test("the fixture exercises the optional fields", async () => {
    const search = JSON.parse((await cli(["search", "RF", "--json"])).stdout);
    expect(search.results[0].matched_aliases).toEqual(["RF"]);
    const unlimited = JSON.parse((await cli(["search", "flux", "--json"])).stdout);
    expect(unlimited.count).toBeGreaterThan(1);
    const consumers = JSON.parse((await cli(["consumers", "concepts/forcing", "--json"])).stdout);
    const directions = consumers.results.map((r: { direction: string }) => r.direction);
    expect(directions).toContain("inbound");
    expect(directions).toContain("outbound");
    const dashed = JSON.parse((await cli(["canonical", "--json", "--", "-O2"])).stdout);
    expect(dashed.count).toBeGreaterThan(0);
    const lint = JSON.parse((await cli(["lint", "--json"])).stdout);
    expect(lint.count).toBeGreaterThan(0);
    expect(lint.citations_checked).toBeGreaterThan(0);
    expect(lint.findings.map((f: { kind: string }) => f.kind)).toContain("unloaded-source");
  });
});

describe("an argument a command cannot honour is refused, not ignored", () => {
  for (const r of REFUSED) {
    test(`${r.argv.join(" ")} exits 2`, async () => {
      const { code, stdout, stderr } = await cli(r.argv);
      expect(code).toBe(2);
      expect(stderr).toContain(r.says);
      expect(stdout).toBe("");
    });
  }

  for (const argv of [
    ["search", "--help"],
    ["lint", "-h"],
    ["drift", "--json", "--help"],
  ]) {
    test(`${argv.join(" ")} prints usage and exits 0`, async () => {
      const { code, stdout } = await cli(argv);
      expect(code).toBe(0);
      expect(stdout).toContain("Usage: accreta");
    });
  }

  for (const limit of [0, 51, 2.5]) {
    test(`search_pages refuses limit ${limit} too`, async () => {
      expect((await mcp("search_pages", { query: "flux", limit })).isError).toBe(true);
    });
  }
});

// Past one page the CLI still prints everything; the MCP tool returns the first page of the same list.
describe("past one page, MCP returns the head of the CLI's list", () => {
  const PAGES = 60;
  let bigRoot = "";
  let bigCtx: ToolContext;
  let bigClient: Client;

  async function bigCli(argv: string[]) {
    const out: string[] = [];
    const code = await run(argv, { cwd: bigRoot, out: (line) => out.push(line), err: () => {} });
    return { code, json: JSON.parse(out.join("\n")) as Record<string, unknown> };
  }

  async function bigMcp(tool: string, args: Record<string, unknown>) {
    const result = (await bigClient.callTool({ name: tool, arguments: args })) as {
      content: { text: string }[];
    };
    return JSON.parse(result.content[0]?.text ?? "") as Record<string, unknown>;
  }

  beforeAll(async () => {
    bigRoot = mkdtempSync(join(tmpdir(), "accreta-parity-big-"));
    const put = (path: string, contents: string) => {
      mkdirSync(join(bigRoot, path, ".."), { recursive: true });
      writeFileSync(join(bigRoot, path), contents, "utf-8");
    };
    put(
      "accreta.config.yaml",
      "knowledge_base: knowledge\npage_types: [note]\nlink_fields: [related]\n",
    );
    put("knowledge/hub.md", "---\ntype: note\n---\n\n# Hub\n");
    for (let i = 0; i < PAGES; i++) {
      put(
        `knowledge/p${i}.md`,
        `---\ntype: note\naliases: ["everyone"]\nrelated: [[hub]]\n---\n\n# P${i}\n`,
      );
    }
    expect(await run(["reindex"], { cwd: bigRoot, out: () => {}, err: () => {} })).toBe(0);

    bigCtx = createContext(bigRoot);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    bigClient = new Client({ name: "parity-big-probe", version: "0.0.0" });
    await Promise.all([
      createServer(bigCtx).connect(serverTransport),
      bigClient.connect(clientTransport),
    ]);
  });

  afterAll(async () => {
    await bigClient?.close();
    bigCtx?.db.close();
    rmSync(bigRoot, { recursive: true, force: true });
  });

  const cases = [
    {
      tool: "find_consumers",
      args: { target: "hub" },
      argv: ["consumers", "hub"],
      list: "results",
    },
    {
      tool: "find_canonical",
      args: { term: "everyone" },
      argv: ["canonical", "everyone"],
      list: "results",
    },
    { tool: "lint_knowledge_base", args: {}, argv: ["lint"], list: "findings" },
  ];
  for (const c of cases) {
    test(`${c.tool}: first 50 of ${c.list}, the same count, nextCursor on MCP only`, async () => {
      const fromCli = (await bigCli([...c.argv, "--json"])).json;
      const fromMcp = await bigMcp(c.tool, c.args);
      const all = fromCli[c.list] as unknown[];
      expect(all.length).toBeGreaterThan(50);
      expect(fromCli.count).toBe(all.length);

      expect(fromMcp[c.list]).toEqual(all.slice(0, 50));
      expect(fromMcp.count).toBe(fromCli.count);
      expect(typeof fromMcp.nextCursor).toBe("string");
      expect(fromCli).not.toHaveProperty("nextCursor");

      const { nextCursor: _, ...mcpRest } = fromMcp;
      expect(mcpRest).toStrictEqual({ ...fromCli, [c.list]: all.slice(0, 50) });
    });
  }
});
