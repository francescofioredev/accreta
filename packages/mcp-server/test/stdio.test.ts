import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildIndex, DEFAULT_CONFIG, type AccretaConfig } from "@accreta/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

let root = "";

const config: AccretaConfig = {
  ...DEFAULT_CONFIG,
  knowledgeBase: "knowledge",
  pageTypes: ["note"],
};

const indexPath = () => join(root, ".accreta", "index.sqlite");

function reindex(): void {
  buildIndex({ root, config, indexPath: indexPath() });
}

// What every index a published 0.1.x built looks like to this reader.
function unstamp(): void {
  const db = new DatabaseSync(indexPath());
  db.exec("DELETE FROM meta WHERE key = 'index_format'");
  db.close();
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "accreta-stdio-"));
  mkdirSync(join(root, "knowledge"), { recursive: true });
  writeFileSync(
    join(root, "accreta.config.yaml"),
    "knowledge_base: knowledge\npage_types: [note]\n",
    "utf-8",
  );
  writeFileSync(join(root, "knowledge", "a.md"), "---\ntype: note\n---\n\n# A\n\nalpha\n", "utf-8");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

// Through the bin over real stdio: a server that dies at startup only shows up there.
async function connect(): Promise<Client> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !key.startsWith("ACCRETA_")) env[key] = value;
  }
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--conditions=@accreta/source", join(import.meta.dir, "..", "src", "bin.ts")],
    cwd: root,
    env,
    stderr: "pipe",
  });
  const client = new Client({ name: "stdio-probe", version: "0.0.0" });
  await client.connect(transport);
  return client;
}

type CallResult = { isError?: boolean; content: { type: string; text: string }[] };

function search(client: Client) {
  return client.callTool({ name: "search_pages", arguments: { query: "alpha" } }) as Promise<
    CallResult & { structuredContent?: { count: number } }
  >;
}

async function serveAcrossARebuild(expected: string): Promise<void> {
  const client = await connect();
  try {
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toContain("search_pages");

    const first = await search(client);
    expect(first.isError).toBe(true);
    expect(first.content[0]?.text).toContain(expected);
    expect(first.content[0]?.text).toContain("accreta reindex");

    reindex();
    const second = await search(client);
    expect(second.isError).toBeFalsy();
    expect(second.structuredContent?.count).toBe(1);
  } finally {
    await client.close();
  }
}

test("a server on an index with no format stamp stays up and tells the agent to reindex", async () => {
  reindex();
  unstamp();
  await serveAcrossARebuild("records no format");
}, 20_000);

test("a server with no index yet stays up and tells the agent to reindex", async () => {
  await serveAcrossARebuild("No index at");
}, 20_000);
