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
  check_drift: "#135 gives drift its --json",
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
}

const CASES: Case[] = [
  { tool: "search_pages", args: { query: "tropopause" }, argv: ["search", "tropopause"] },
  { tool: "search_pages", args: { query: "RF" }, argv: ["search", "RF"] },
  {
    tool: "search_pages",
    args: { query: "flux", types: ["concept"], source: "docs", limit: 1 },
    argv: ["search", "flux", "--type", "concept", "--source", "docs", "--limit", "1"],
  },
  {
    tool: "search_pages",
    args: { query: "flux", limit: 1 },
    argv: ["search", "flux", "--limit", "1"],
  },
  { tool: "search_pages", args: { query: "nothingmatches" }, argv: ["search", "nothingmatches"] },
  { tool: "get_page", args: { path: "concepts/forcing" }, argv: ["show", "concepts/forcing"] },
  { tool: "get_page", args: { path: "concepts/nothing" }, argv: ["show", "concepts/nothing"] },
  {
    tool: "find_consumers",
    args: { target: "concepts/forcing" },
    argv: ["consumers", "concepts/forcing"],
  },
  {
    tool: "find_consumers",
    args: { target: "concepts/forcing", include_inline: true },
    argv: ["consumers", "concepts/forcing", "--inline"],
  },
  { tool: "find_consumers", args: { target: "missing" }, argv: ["consumers", "missing"] },
  { tool: "find_canonical", args: { term: "RF" }, argv: ["canonical", "RF"] },
  { tool: "find_canonical", args: { term: "nothing" }, argv: ["canonical", "nothing"] },
  { tool: "lint_knowledge_base", args: {}, argv: ["lint"] },
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
  write("src-docs/forcing.md", "one\ntwo\nthree\n");
  write(
    "knowledge/concepts/forcing.md",
    "---\ntype: concept\nsource: docs\naliases: [RF, radiative forcing]\n" +
      'canonical_source: "docs:forcing.md#L2"\nlast_verified_revision: r1\n---\n\n' +
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
      const [fromCli, fromMcp] = [await cli([...c.argv, "--json"]), await mcp(c.tool, c.args)];
      expect(fromMcp.isError).toBe(false);
      expect(JSON.parse(fromCli.stdout)).toStrictEqual(JSON.parse(fromMcp.text));
    });
  }

  // Fixture guard: a case that compared two empty answers would prove nothing.
  test("the fixture exercises the optional fields", async () => {
    const search = JSON.parse((await cli(["search", "RF", "--json"])).stdout);
    expect(search.results[0].matched_aliases).toEqual(["RF"]);
    const unlimited = JSON.parse((await cli(["search", "flux", "--json"])).stdout);
    expect(unlimited.count).toBeGreaterThan(1);
    const lint = JSON.parse((await cli(["lint", "--json"])).stdout);
    expect(lint.count).toBeGreaterThan(0);
    expect(lint.citations_checked).toBeGreaterThan(0);
  });
});

describe("--limit is bounded where the MCP schema bounds it", () => {
  for (const limit of ["0", "51", "2.5"]) {
    test(`--limit ${limit} is refused by both`, async () => {
      const fromCli = await cli(["search", "flux", "--limit", limit, "--json"]);
      const fromMcp = await mcp("search_pages", { query: "flux", limit: Number(limit) });
      expect(fromCli.code).toBe(1);
      expect(fromCli.stderr).toContain("--limit");
      expect(fromMcp.isError).toBe(true);
    });
  }
});
