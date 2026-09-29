import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildIndex, DEFAULT_CONFIG, openIndex, type AccretaConfig } from "@accreta/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  createServer,
  findCanonicalTool,
  findConsumersTool,
  lintTool,
  type ToolContext,
} from "../src/index.ts";

const PAGES = 60;

let root = "";
let ctx: ToolContext;
let client: Client;

const config: AccretaConfig = {
  ...DEFAULT_CONFIG,
  knowledgeBase: "knowledge",
  pageTypes: ["note"],
  linkFields: ["related"],
};

// Every page links to the hub, shares an alias, and lacks provenance: all three lists exceed a page.
beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "accreta-mcp-paging-"));
  mkdirSync(join(root, "knowledge"), { recursive: true });
  writeFileSync(join(root, "knowledge", "hub.md"), "---\ntype: note\n---\n\n# Hub\n");
  for (let i = 0; i < PAGES; i++) {
    writeFileSync(
      join(root, "knowledge", `p${i}.md`),
      `---\ntype: note\naliases: ["everyone"]\nrelated: [[hub]]\n---\n\n# P${i}\n`,
    );
  }
  const indexPath = join(root, ".accreta", "index.sqlite");
  buildIndex({ root, config, indexPath });
  ctx = {
    db: openIndex(indexPath, { readonly: true }),
    config,
    root,
    sources: new Map(),
    unloadedSources: [],
    writesEnabled: false,
  };
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "paging-probe", version: "0.0.0" });
  await Promise.all([createServer(ctx).connect(serverTransport), client.connect(clientTransport)]);
});

afterAll(async () => {
  await client?.close();
  ctx?.db.close();
  rmSync(root, { recursive: true, force: true });
});

describe("list tools return a page and the untruncated count", () => {
  test("find_consumers", () => {
    const first = findConsumersTool(ctx, { target: "hub" });
    expect(first.results).toHaveLength(50);
    expect(first.count).toBe(PAGES);
    const rest = findConsumersTool(ctx, { target: "hub", cursor: first.nextCursor });
    expect(rest.results).toHaveLength(PAGES - 50);
    expect(rest.nextCursor).toBeUndefined();
  });

  test("find_canonical", () => {
    const first = findCanonicalTool(ctx, { term: "everyone", limit: 25 });
    expect(first.results).toHaveLength(25);
    expect(first.count).toBe(PAGES);
    expect(first.nextCursor).toBeDefined();
  });

  test("lint_knowledge_base", async () => {
    const first = await lintTool(ctx, { limit: 10 });
    expect(first.findings).toHaveLength(10);
    // Two findings per page: no canonical_source, no last_verified_revision.
    expect(first.count).toBe(2 * (PAGES + 1));
    const second = await lintTool(ctx, { limit: 10, cursor: first.nextCursor });
    expect(second.findings[0]).not.toEqual(first.findings[0]);
  });
});

async function call(name: string, args: Record<string, unknown>) {
  const result = (await client.callTool({ name, arguments: args })) as {
    content: { text: string }[];
    isError?: boolean;
  };
  return { isError: result.isError ?? false, text: result.content[0]?.text ?? "" };
}

describe("over the protocol", () => {
  test("the cursor round-trips through lint_knowledge_base", async () => {
    const first = JSON.parse((await call("lint_knowledge_base", { limit: 50 })).text);
    expect(first.findings).toHaveLength(50);
    const next = await call("lint_knowledge_base", { cursor: first.nextCursor });
    expect(next.isError).toBe(false);
    expect(JSON.parse(next.text).findings).toHaveLength(Math.min(50, first.count - 50));
  });

  test("the last page carries no nextCursor at all", async () => {
    const all = JSON.parse((await call("find_canonical", { term: "hub" })).text);
    expect(all.count).toBe(1);
    expect(all).not.toHaveProperty("nextCursor");
  });

  test("lint_knowledge_base filters by kind, and counts only what it kept", async () => {
    const only = JSON.parse(
      (await call("lint_knowledge_base", { kinds: ["unverified-page"] })).text,
    );
    expect(only.count).toBe(PAGES + 1);
    expect(new Set(only.findings.map((f: { kind: string }) => f.kind))).toEqual(
      new Set(["unverified-page"]),
    );
  });

  test("lint_knowledge_base refuses an empty kinds list rather than reading it as every kind", async () => {
    expect((await call("lint_knowledge_base", { kinds: [] })).isError).toBe(true);
  });

  // A misspelt kind would otherwise read as "nothing wrong".
  test("lint_knowledge_base refuses a kind that does not exist", async () => {
    expect((await call("lint_knowledge_base", { kinds: ["unverifed-page"] })).isError).toBe(true);
  });

  for (const tool of ["find_consumers", "find_canonical", "lint_knowledge_base"]) {
    const base: Record<string, unknown> =
      tool === "find_consumers"
        ? { target: "hub" }
        : tool === "find_canonical"
          ? { term: "everyone" }
          : {};

    test(`${tool} refuses a limit above 50 rather than clamping it silently`, async () => {
      expect((await call(tool, { ...base, limit: 51 })).isError).toBe(true);
    });

    test(`${tool} names an invalid cursor as one`, async () => {
      const result = await call(tool, { ...base, cursor: "not-a-cursor" });
      expect(result.isError).toBe(true);
      expect(result.text).toContain("Invalid cursor");
    });
  }
});
