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
  cite: "cite",
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
  {
    tool: "cite",
    args: { target: "docs:forcing.md#L2" },
    argv: ["cite", "docs:forcing.md#L2"],
    code: 0,
  },
  {
    tool: "cite",
    args: { target: "docs:forcing.md#L9" },
    argv: ["cite", "docs:forcing.md#L9"],
    code: 1,
  },
  { tool: "cite", args: { target: "repo:a.md#L1" }, argv: ["cite", "repo:a.md#L1"], code: 0 },
  { tool: "cite", args: { target: "repo:dirty.md" }, argv: ["cite", "repo:dirty.md"], code: 0 },
  {
    tool: "cite",
    args: { target: "wiki:design-page#block-a1" },
    argv: ["cite", "wiki:design-page#block-a1"],
    code: 0,
  },
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
  { argv: ["lint", "--limit", "51"], says: "--limit" },
  { argv: ["lint", "--cursor"], says: "--cursor needs a value" },
  { argv: ["consumers", "concepts/forcing", "--limit", "0"], says: "--limit" },
  { argv: ["canonical", "RF", "--limit", "2.5"], says: "--limit" },
  { argv: ["search", "flux", "--cursor", "abc"], says: "search has no --cursor yet (#183)" },
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
  { argv: ["cite"], says: "Usage: accreta cite" },
  { argv: ["cite", "forcing.md"], says: "is not source:path[#locator]" },
  { argv: ["cite", "docs:forcing.md", "repo:a.md"], says: 'cite does not take "repo:a.md"' },
  { argv: ["cite", "docs:forcing.md", "--limit", "1"], says: "cite does not take --limit" },
  {
    argv: ["cite", "docs:forcing.md", "--expect-revision"],
    says: "--expect-revision needs a value",
  },
];

let root = "";
let head = "";
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
  const io = {
    cwd: root,
    out: (line: string) => out.push(line),
    err: (line: string) => err.push(line),
  };
  // As main.ts does outside `run`: a thrown refusal is its message on stderr and exit 1.
  const code = await run(argv, io).catch((error: Error) => (io.err(error.message), 1));
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
  write("sources/repo.yaml", "id: repo\ntype: git\nroot: src-repo\n");
  write("src-repo/a.md", "alpha\n");
  write("src-repo/dirty.md", "committed\n");
  const repo = join(root, "src-repo");
  for (const args of [
    ["init", "-q"],
    ["add", "."],
    ["commit", "-qm", "first"],
  ]) {
    const identity = ["-c", "user.name=T", "-c", "user.email=t@example.invalid"];
    expect(Bun.spawnSync(["git", ...identity, ...args], { cwd: repo }).exitCode).toBe(0);
  }
  head = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: repo }).stdout.toString().trim();
  write("src-repo/dirty.md", "edited, not committed\n");
  write(
    "sources/wiki.yaml",
    "id: wiki\ntype: delegated\nvia: notion\nscope: |\n  The design pages.\n",
  );
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

describe("cite", () => {
  const cited = async (argv: string[]) => JSON.parse((await cli([...argv, "--json"])).stdout);

  // Fixture guard: the parity cases above are only worth something if each source answers as its kind should.
  test("fs and git pin a revision where they could check the place", async () => {
    const fs = await cited(["cite", "docs:forcing.md#L2"]);
    expect(fs.location).toEqual({ verdict: "found" });
    expect(fs.revision).toMatch(/\S/);
    expect(fs.footnote).toBe(`docs @ ${fs.revision} · forcing.md#L2`);

    const git = await cited(["cite", "repo:a.md#L1"]);
    expect(git.revision).toBe(head);
    expect(git.canonical_source).toBe("repo:a.md#L1");

    const dirty = await cited(["cite", "repo:dirty.md"]);
    expect(dirty.revision).toBeNull();
    expect(dirty.location.verdict).toBe("unknown");
  });

  test("a delegated source says it cannot pin a revision rather than inventing one", async () => {
    const out = await cited(["cite", "wiki:design-page#block-a1"]);
    expect(out.revision).toBeNull();
    expect(out.footnote).toBe("wiki @ unknown · design-page#block-a1");
    expect(out.location.verdict).toBe("unknown");
    expect(out.delegated).toEqual({ via: "notion", scope: "The design pages.\n" });
  });

  test("the expected revision passes when the source has not moved", async () => {
    const fromCli = await cli(["cite", "repo:a.md#L1", "--expect-revision", head, "--json"]);
    const fromMcp = await mcp("cite", { target: "repo:a.md#L1", expect_revision: head });
    expect(fromCli.code).toBe(0);
    expect(fromMcp.isError).toBe(false);
    expect(JSON.parse(fromCli.stdout)).toStrictEqual(JSON.parse(fromMcp.text));
  });

  // Each refusal is the same sentence on both surfaces, and never a footnote.
  const refusals = [
    {
      name: "the source moved after the read",
      args: { target: "repo:a.md#L1", expect_revision: "0000000" },
      says: "not 0000000: it moved after you read it",
    },
    {
      name: "a delegated source cannot confirm a revision",
      args: { target: "wiki:design-page", expect_revision: "v7" },
      says: "read through notion, and accreta cannot tell its revision",
    },
    {
      name: "an unchecked place cannot confirm a revision",
      args: { target: "repo:dirty.md", expect_revision: "0000000" },
      says: "accreta could not check this place",
    },
    {
      name: "an unknown source",
      args: { target: "nope:a.md" },
      says: 'Unknown source "nope"',
    },
    {
      name: "a declared source that did not load",
      args: { target: "typo:a.md" },
      says: 'Source "typo" is declared in',
    },
    {
      name: "a path that is not canonical",
      args: { target: "docs:../forcing.md" },
      says: "is not canonical",
    },
  ];
  for (const r of refusals) {
    test(`refuses ${r.name}`, async () => {
      const expected = (r.args as { expect_revision?: string }).expect_revision;
      const argv = ["cite", r.args.target, "--json"];
      if (expected) argv.push("--expect-revision", expected);
      const [fromCli, fromMcp] = [await cli(argv), await mcp("cite", r.args)];
      expect(fromMcp.isError).toBe(true);
      expect(fromCli.code).toBe(1);
      expect(fromCli.stdout).toBe("");
      expect(fromCli.stderr).toBe(fromMcp.text);
      expect(fromMcp.text).toContain(r.says);
    });
  }

  test("a target outside the grammar is a usage error on the CLI and the same sentence over MCP", async () => {
    const [fromCli, fromMcp] = [
      await cli(["cite", "forcing.md"]),
      await mcp("cite", { target: "forcing.md" }),
    ];
    expect(fromCli.code).toBe(2);
    expect(fromMcp.isError).toBe(true);
    expect(fromCli.stderr).toBe(fromMcp.text);
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

const member = (i: number) =>
  `---\ntype: note\naliases: ["everyone"]\nrelated: [[hub]]\n---\n\n# P${i}\n`;

/** A knowledge base where every paged list runs past 50, with a CLI and an MCP client over it. */
async function openManyPages(pages: number) {
  const dir = mkdtempSync(join(tmpdir(), "accreta-parity-big-"));
  const put = (path: string, contents: string) => {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), contents, "utf-8");
  };
  put(
    "accreta.config.yaml",
    "knowledge_base: knowledge\npage_types: [note]\nlink_fields: [related]\n",
  );
  put("knowledge/hub.md", "---\ntype: note\n---\n\n# Hub\n");
  for (let i = 0; i < pages; i++) put(`knowledge/p${i}.md`, member(i));
  expect(await run(["reindex"], { cwd: dir, out: () => {}, err: () => {} })).toBe(0);

  const toolCtx = createContext(dir);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcpClient = new Client({ name: "parity-big-probe", version: "0.0.0" });
  await Promise.all([
    createServer(toolCtx).connect(serverTransport),
    mcpClient.connect(clientTransport),
  ]);

  return {
    put,
    async cli(argv: string[]) {
      const out: string[] = [];
      const err: string[] = [];
      const code = await run(argv, {
        cwd: dir,
        out: (line) => out.push(line),
        err: (line) => err.push(line),
      });
      return { code, stdout: out.join("\n"), stderr: err.join("\n") };
    },
    async mcp(tool: string, args: Record<string, unknown>) {
      const result = (await mcpClient.callTool({ name: tool, arguments: args })) as {
        content: { text: string }[];
        isError?: boolean;
      };
      return { text: result.content[0]?.text ?? "", isError: result.isError === true };
    },
    async close() {
      await mcpClient.close();
      toolCtx.db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

// Past one page, `--limit` and `--cursor` page the CLI exactly as `limit` and `cursor` page MCP.
describe("past one page, the CLI pages as MCP does", () => {
  const PAGES = 60;
  let big: Awaited<ReturnType<typeof openManyPages>>;
  const bigCli = (argv: string[]) => big.cli(argv);
  const bigMcp = (tool: string, args: Record<string, unknown>) => big.mcp(tool, args);

  beforeAll(async () => {
    big = await openManyPages(PAGES);
  });

  afterAll(async () => {
    await big?.close();
  });

  const cases = [
    {
      tool: "find_consumers",
      args: { target: "hub" },
      argv: ["consumers", "hub"],
      list: "results",
      code: 0,
    },
    {
      tool: "find_canonical",
      args: { term: "everyone" },
      argv: ["canonical", "everyone"],
      list: "results",
      code: 0,
    },
    { tool: "lint_knowledge_base", args: {}, argv: ["lint"], list: "findings", code: 1 },
  ];

  for (const c of cases) {
    test(`${c.argv[0]} without --limit still prints all of ${c.list}, and no cursor`, async () => {
      const fromCli = await bigCli([...c.argv, "--json"]);
      const all = JSON.parse(fromCli.stdout) as Record<string, unknown>;
      const fromMcp = JSON.parse((await bigMcp(c.tool, c.args)).text) as Record<string, unknown>;
      expect(fromCli.code).toBe(c.code);
      expect((all[c.list] as unknown[]).length).toBeGreaterThan(50);
      expect(all.count).toBe((all[c.list] as unknown[]).length);
      expect(all).not.toHaveProperty("nextCursor");
      expect(fromMcp[c.list]).toEqual((all[c.list] as unknown[]).slice(0, 50));
    });

    test(`${c.argv[0]} --json --limit 50 prints what ${c.tool} returns, byte for byte`, async () => {
      const fromCli = await bigCli([...c.argv, "--json", "--limit", "50"]);
      const fromMcp = await bigMcp(c.tool, { ...c.args, limit: 50 });
      expect(fromMcp.isError).toBe(false);
      expect(fromCli.code).toBe(c.code);
      expect(fromCli.stdout).toBe(fromMcp.text);
      expect(JSON.parse(fromCli.stdout).nextCursor).toEqual(expect.any(String));
    });

    for (const limit of [50, 7]) {
      test(`${c.argv[0]}: following cursors at --limit ${limit} from either side rebuilds the list`, async () => {
        const all = JSON.parse((await bigCli([...c.argv, "--json"])).stdout)[c.list];

        const walk = async (side: "cli" | "mcp" | "alternate") => {
          const seen: unknown[] = [];
          let cursor: string | undefined;
          for (let turn = 0; ; turn++) {
            const viaCli = side === "cli" || (side === "alternate" && turn % 2 === 0);
            const text = viaCli
              ? (
                  await bigCli([
                    ...c.argv,
                    "--json",
                    "--limit",
                    String(limit),
                    ...(cursor ? ["--cursor", cursor] : []),
                  ])
                ).stdout
              : (await bigMcp(c.tool, { ...c.args, limit, ...(cursor ? { cursor } : {}) })).text;
            const page = JSON.parse(text) as Record<string, unknown>;
            expect(page.count).toBe(all.length);
            seen.push(...(page[c.list] as unknown[]));
            cursor = page.nextCursor as string | undefined;
            if (!cursor) return seen;
          }
        };

        expect(await walk("cli")).toEqual(all);
        expect(await walk("mcp")).toEqual(all);
        // A cursor is the index's, not the surface's: one issued by either is honoured by both.
        expect(await walk("alternate")).toEqual(all);
      });
    }

    test(`${c.argv[0]} and ${c.tool} refuse a malformed cursor in the same words`, async () => {
      const fromCli = await bigCli([...c.argv, "--json", "--cursor", "not-a-cursor"]);
      const fromMcp = await bigMcp(c.tool, { ...c.args, cursor: "not-a-cursor" });
      expect(fromMcp.isError).toBe(true);
      expect(fromMcp.text).toContain("Invalid cursor");
      expect(fromCli.code).toBe(2);
      expect(fromCli.stdout).toBe("");
      expect(fromCli.stderr).toBe(fromMcp.text);
    });
  }

  test("a cursor from another query is refused the same way on both surfaces", async () => {
    const foreign = JSON.parse(
      (await bigCli(["consumers", "hub", "--json", "--limit", "5"])).stdout,
    ).nextCursor as string;
    for (const c of cases.filter((other) => other.tool !== "find_consumers")) {
      const fromCli = await bigCli([...c.argv, "--cursor", foreign]);
      const fromMcp = await bigMcp(c.tool, { ...c.args, cursor: foreign });
      expect(fromMcp.isError).toBe(true);
      expect(fromCli.code).toBe(2);
      expect(fromCli.stderr).toBe(fromMcp.text);
    }
  });

  // Its own knowledge base: the change it makes would break any cursor walk running beside it.
  test("a cursor gone stale after a change and a reindex is refused the same way on both", async () => {
    const own = await openManyPages(PAGES);
    try {
      const stale = new Map<string, string>();
      for (const c of cases) {
        const page = JSON.parse((await own.cli([...c.argv, "--json", "--limit", "5"])).stdout);
        stale.set(c.tool, page.nextCursor as string);
      }
      own.put(`knowledge/p${PAGES}.md`, member(PAGES));
      expect((await own.cli(["reindex"])).code).toBe(0);

      for (const c of cases) {
        const cursor = stale.get(c.tool)!;
        const fromCli = await own.cli([...c.argv, "--json", "--cursor", cursor]);
        const fromMcp = await own.mcp(c.tool, { ...c.args, cursor });
        expect(fromMcp.isError).toBe(true);
        expect(fromMcp.text).toContain("Invalid cursor");
        expect(fromCli.code).toBe(2);
        expect(fromCli.stdout).toBe("");
        expect(fromCli.stderr).toBe(fromMcp.text);
      }
    } finally {
      await own.close();
    }
  });
});
