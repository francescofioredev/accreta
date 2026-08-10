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
