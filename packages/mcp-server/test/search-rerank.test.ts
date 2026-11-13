import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildIndex, DEFAULT_CONFIG, openIndex, parseConfig } from "@accreta/core";
import { startFakeJudge, type FakeJudgeOptions } from "@accreta/judges/testing";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer, searchPagesTool } from "../src/index.ts";
import type { ToolContext } from "../src/index.ts";

const SECRET = "sk-test-mcp-rerank-0123456789";
const ENV_KEYS = ["ACCRETA_JUDGE_URL", "ACCRETA_JUDGE_KEY"];
const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

let root = "";
let ctx: ToolContext;

const byTitle =
  (table: Record<string, number>): FakeJudgeOptions["noul"] =>
  (name, _question, request) => {
    const state = request.body.state as { candidates: { id: string; title: string }[] };
    return table[state.candidates.find((c) => c.id === name)?.title ?? ""] ?? 0;
  };

function build(withJudge: boolean): void {
  const config = withJudge
    ? { ...DEFAULT_CONFIG, ...parseConfig("judge:\n  route: local\n") }
    : DEFAULT_CONFIG;
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
}

async function call(args: Record<string, unknown>) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "rerank-probe", version: "0.0.0" });
  await Promise.all([createServer(ctx).connect(serverTransport), client.connect(clientTransport)]);
  try {
    const result = await client.callTool({ name: "search_pages", arguments: args });
    return result.structuredContent as {
      count: number;
      results: { title: string; judge?: string; model?: string; probability?: number }[];
      rerank_note?: string;
      _provenance: { page_derived_fields: string[] };
    };
  } finally {
    await client.close();
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "accreta-mcp-rerank-"));
  for (const key of ENV_KEYS) delete process.env[key];
  mkdirSync(join(root, "knowledge"), { recursive: true });
  for (const title of ["Alpha", "Bravo", "Charlie"]) {
    writeFileSync(
      join(root, "knowledge", `${title.toLowerCase()}.md`),
      `---\ntype: note\n---\n\n# ${title}\n\nThe ${title} page discusses tropopause flux.\n`,
    );
  }
});

afterEach(() => {
  ctx?.db.close();
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  rmSync(root, { recursive: true, force: true });
});

test("rerank: true reorders and labels each hit with judge, model and probability", async () => {
  const fake = await startFakeJudge({
    model: "fake-jev-3",
    noul: byTitle({ Alpha: 0.1, Bravo: 0.2, Charlie: 0.95 }),
  });
  process.env.ACCRETA_JUDGE_URL = fake.url;
  build(true);
  const out = await call({ query: "tropopause", rerank: true });
  expect(out.results.map((r) => r.title)).toEqual(["Charlie", "Bravo", "Alpha"]);
  expect(out.results[0]).toMatchObject({ judge: "local", model: "fake-jev-3", probability: 0.95 });
  expect(out.rerank_note).toBeUndefined();
  expect(out._provenance.page_derived_fields).toContain("results[].model");
  expect(fake.requests).toHaveLength(1);
  await fake.close();
});

test("limit applies after the rerank, so a lower hit can be promoted into it", async () => {
  const fake = await startFakeJudge({ noul: byTitle({ Charlie: 1 }) });
  process.env.ACCRETA_JUDGE_URL = fake.url;
  build(true);
  const out = await call({ query: "tropopause", rerank: true, limit: 1 });
  expect(out.results.map((r) => r.title)).toEqual(["Charlie"]);
  await fake.close();
});

test("without rerank a configured judge is not called and the answer has no judged fields", async () => {
  const fake = await startFakeJudge();
  process.env.ACCRETA_JUDGE_URL = fake.url;
  build(true);
  const out = await call({ query: "tropopause" });
  expect(fake.requests).toHaveLength(0);
  expect(JSON.stringify(out)).not.toContain("probability");
  expect(out).toEqual(JSON.parse(JSON.stringify(searchPagesTool(ctx, { query: "tropopause" }))));
  await fake.close();
});

test("rerank with no judge block says so and keeps the search order", async () => {
  build(false);
  const plain = await call({ query: "tropopause" });
  const out = await call({ query: "tropopause", rerank: true });
  expect(out.results).toEqual(plain.results);
  expect(out.rerank_note).toMatch(/No judge is configured/);
  expect(out._provenance.page_derived_fields).toContain("rerank_note");
});

test("an unreachable judge degrades to the search order with a note", async () => {
  const fake = await startFakeJudge({ failWith: [500, 500, 500, 500] });
  process.env.ACCRETA_JUDGE_URL = fake.url;
  build(true);
  const plain = await call({ query: "tropopause" });
  const out = await call({ query: "tropopause", rerank: true });
  expect(out.results).toEqual(plain.results);
  expect(out.rerank_note).toMatch(/could not rerank/);
  await fake.close();
});

test("a block that cannot make a judge degrades and never echoes the key", async () => {
  process.env.ACCRETA_JUDGE_KEY = SECRET;
  build(true);
  const out = await call({ query: "tropopause", rerank: true });
  expect(out.rerank_note).toMatch(/ACCRETA_JUDGE_URL is required/);
  expect(JSON.stringify(out)).not.toContain(SECRET);
});
