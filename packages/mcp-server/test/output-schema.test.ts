import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildIndex, DEFAULT_CONFIG, openIndex, type AccretaConfig } from "@accreta/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import { createServer, type ToolContext } from "../src/index.ts";

let root = "";
let ctx: ToolContext;
let client: Client;

const config: AccretaConfig = {
  ...DEFAULT_CONFIG,
  knowledgeBase: "knowledge",
  pageTypes: ["concept", "note"],
  linkFields: ["related"],
};

function writePage(relativePath: string, contents: string): void {
  const full = join(root, "knowledge", relativePath);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, contents, "utf-8");
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "accreta-output-schema-"));
  // An unquoted YAML date parses to a Date, which only the JSON round trip turns into a string.
  writePage(
    "concepts/forcing.md",
    '---\ntype: concept\naliases: ["climate forcing"]\ncanonical_source: "ipcc:ch07.md#L1"\nlast_verified_revision: abc123\nreviewed: 2026-01-02\nrelated: [[notes/a]]\n---\n\n# Radiative forcing\n\ntropopause flux\n',
  );
  writePage("notes/a.md", "---\ntype: note\n---\n\n# A note\n\ntropopause aside\n");
  writePage("notes/tagged.md", "---\n!!timestamp 2026-01-02\n---\n\n# T\n\nzebraword\n");
  const indexPath = join(root, ".accreta", "index.sqlite");
  buildIndex({ root, config, indexPath });
  ctx = {
    db: openIndex(indexPath, { readonly: true }),
    config,
    root,
    sources: new Map(),
    unloadedSources: [],
    writesEnabled: true,
  };
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "output-schema-probe", version: "0.0.0" });
  await Promise.all([createServer(ctx).connect(serverTransport), client.connect(clientTransport)]);
  // The client validates structuredContent only for tools whose schema it has listed.
  await client.listTools();
});

afterEach(async () => {
  await client.close();
  ctx.db.close();
  rmSync(root, { recursive: true, force: true });
});

interface Reply {
  content: { type: string; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

async function call(name: string, args: Record<string, unknown>): Promise<Reply> {
  const reply = (await client.callTool({ name, arguments: args })) as Reply;
  expect(reply.isError).toBeUndefined();
  expect(reply.structuredContent).toBeDefined();
  // The text block is for clients that read only text, so it must say exactly what the structured copy does.
  expect(reply.content).toHaveLength(1);
  expect(JSON.parse(reply.content[0]?.text ?? "")).toEqual(reply.structuredContent);
  return reply;
}

describe("outputSchema", () => {
  test("is declared by search_pages and get_page only, writes enabled", async () => {
    const { tools } = await client.listTools();
    expect(tools.some((tool) => tool.name === "update_verified_revision")).toBe(true);
    const declared = tools.filter((tool) => tool.outputSchema).map((tool) => tool.name);
    expect(declared.toSorted()).toEqual(["get_page", "search_pages"]);
  });

  test("search_pages returns a hit set that validates", async () => {
    const { structuredContent } = await call("search_pages", { query: "tropopause" });
    expect(structuredContent?.count).toBe(2);
    const results = structuredContent?.results as { path: string }[];
    const paths = results.map((hit) => hit.path);
    expect(paths.toSorted()).toEqual(["knowledge/concepts/forcing.md", "knowledge/notes/a.md"]);
  });

  test("search_pages returns an empty hit set that validates", async () => {
    const { structuredContent } = await call("search_pages", { query: "nothingmatches" });
    expect(structuredContent).toMatchObject({ count: 0, results: [] });
  });

  test("get_page returns a found page that validates", async () => {
    const { structuredContent } = await call("get_page", { path: "concepts/forcing" });
    expect(structuredContent?.found).toBe(true);
    const page = structuredContent?.page as { title: string; frontmatter: { reviewed: unknown } };
    expect(page.title).toBe("Radiative forcing");
    expect(typeof page.frontmatter.reviewed).toBe("string");
    expect(structuredContent?._provenance).toBeDefined();
  });

  test("get_page on a page whose frontmatter is a tagged scalar validates", async () => {
    const { structuredContent } = await call("get_page", { path: "notes/tagged" });
    const page = structuredContent?.page as { title: string; frontmatter: unknown };
    expect(page.title).toBe("T");
    expect(page.frontmatter).toEqual({});
  });

  test("get_page returns a miss that validates", async () => {
    const { structuredContent } = await call("get_page", { path: "concepts/absent" });
    expect(structuredContent).toEqual({
      found: false,
      message: 'No page matches "concepts/absent".',
    });
  });

  test("a reply that breaks the advertised schema is rejected by the SDK's validator", async () => {
    const { tools } = await client.listTools();
    const schema = tools.find((tool) => tool.name === "get_page")?.outputSchema;
    expect(schema).toBeDefined();
    const validate = new AjvJsonSchemaValidator().getValidator(schema as Record<string, unknown>);
    const { structuredContent } = await call("get_page", { path: "concepts/forcing" });
    expect(validate(structuredContent).valid).toBe(true);
    const page = structuredContent?.page as Record<string, unknown>;
    expect(validate({ ...structuredContent, found: "yes" }).valid).toBe(false);
    expect(validate({ ...structuredContent, page: { ...page, body: 42 } }).valid).toBe(false);
    expect(validate({ ...structuredContent, page: { ...page, title: undefined } }).valid).toBe(
      false,
    );
    expect(validate({ ...structuredContent, extra: "unlabelled" }).valid).toBe(false);
  });
});
