import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildIndex, DEFAULT_CONFIG, openIndex } from "@accreta/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/index.ts";
import type { ToolContext } from "../src/index.ts";

let root = "";
let ctx: ToolContext;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "accreta-server-"));
  const indexPath = join(root, ".accreta", "index.sqlite");
  buildIndex({ root, config: DEFAULT_CONFIG, indexPath });
  ctx = {
    db: openIndex(indexPath, { readonly: true }),
    config: DEFAULT_CONFIG,
    root,
    sources: new Map(),
    unloadedSources: [],
    writesEnabled: false,
  };
});

afterEach(() => {
  ctx?.db.close();
  rmSync(root, { recursive: true, force: true });
});

/**
 * Asserted through a real handshake rather than by reading the constant back,
 * because the value only matters at the point a client asks for it — which is
 * exactly the question that could not be answered while this was hardcoded.
 */
test("the server reports the version its package declares", async () => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "version-probe", version: "0.0.0" });

  await Promise.all([createServer(ctx).connect(serverTransport), client.connect(clientTransport)]);

  try {
    const manifest = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf-8"),
    ) as { version: string };

    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(client.getServerVersion()).toEqual({ name: "accreta", version: manifest.version });
  } finally {
    await client.close();
  }
});

/**
 * Asserted through the real transport because the envelope has to survive
 * serialization to be worth anything, and because it must not cost the response
 * its parseability — the reason the notice is a field inside the JSON rather
 * than a preamble in front of it.
 */
test("the provenance block survives a real tool call", async () => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "provenance-probe", version: "0.0.0" });

  await Promise.all([createServer(ctx).connect(serverTransport), client.connect(clientTransport)]);

  try {
    const result = (await client.callTool({
      name: "search_pages",
      arguments: { query: "anything" },
    })) as { content: { text: string }[] };

    const payload = JSON.parse(result.content[0]?.text ?? "") as {
      _provenance: { notice: string; page_derived_fields: string[] };
    };
    expect(payload._provenance.page_derived_fields).toContain("results[].title");
    expect(payload._provenance.notice).toContain("does not prevent");
  } finally {
    await client.close();
  }
});

// Only the parenthesised field list counts: "type", "source" and "aliases" appear elsewhere for other reasons.
test("search_pages names every column the FTS index searches", async () => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "description-probe", version: "0.0.0" });

  await Promise.all([createServer(ctx).connect(serverTransport), client.connect(clientTransport)]);

  try {
    const { sql } = ctx.db
      .query("SELECT sql FROM sqlite_master WHERE name = 'pages_fts'")
      .get() as { sql: string };
    const searched = sql
      .slice(sql.indexOf("(") + 1, sql.lastIndexOf(")"))
      .split(",")
      .map((column) => column.trim())
      .filter((column) => !column.includes("=") && !/\bUNINDEXED\b/i.test(column));
    expect(searched.length).toBeGreaterThan(0);

    const { tools } = await client.listTools();
    const description = tools.find((tool) => tool.name === "search_pages")?.description ?? "";
    const fields = description.match(/\(([^)]*)\)/)?.[1];
    expect(fields).toBeDefined();
    for (const column of searched) expect(fields).toContain(column);
  } finally {
    await client.close();
  }
});
