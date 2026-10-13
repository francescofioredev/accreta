import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildIndex,
  DEFAULT_CONFIG,
  DelegatedSourceError,
  openIndex,
  type SourceAdapter,
} from "@accreta/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer, type ToolContext } from "../src/index.ts";

const ARGS: Record<string, Record<string, string>> = {
  ingest_source: { target: "docs:ch01.md" },
  reverify_stale_pages: { source: "docs" },
  answer_with_citations: { question: "What sets the forcing?" },
};

const config = { ...DEFAULT_CONFIG, knowledgeBase: "knowledge" };

// One stale source and one delegated, so check_drift's reply carries every field the reverify prompt names.
const stub = (id: string, revision: () => Promise<string>): SourceAdapter => ({
  id,
  revision,
  changedSince: async () => ["ch.md"],
  locate: async () => ({ verdict: "found" }),
  citation: () => "",
  pinRevision: () => {},
});

/** Every key in a value, at any depth. */
function keys(value: unknown, into = new Set<string>()): Set<string> {
  if (Array.isArray(value)) for (const item of value) keys(item, into);
  else if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      into.add(key);
      keys(child, into);
    }
  }
  return into;
}

let root = "";
let ctx: ToolContext;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "accreta-prompts-"));
  mkdirSync(join(root, "knowledge"), { recursive: true });
  for (const source of ["docs", "agent"]) {
    writeFileSync(
      join(root, "knowledge", `${source}.md`),
      `---\ntype: concept\nsource: ${source}\nlast_verified_revision: r1\n---\n\n# ${source}\n`,
    );
  }
  const indexPath = join(root, ".accreta", "index.sqlite");
  buildIndex({ root, config, indexPath });
  ctx = {
    db: openIndex(indexPath, { readonly: true }),
    config,
    root,
    sources: new Map([
      ["docs", stub("docs", async () => "r2")],
      [
        "agent",
        stub("agent", async () => {
          throw new DelegatedSourceError("agent", "a connector", "everything");
        }),
      ],
    ]),
    unloadedSources: [],
    writesEnabled: false,
  };
});

afterEach(() => {
  ctx?.db.close();
  rmSync(root, { recursive: true, force: true });
});

async function withClient<T>(writesEnabled: boolean, run: (client: Client) => Promise<T>) {
  ctx.writesEnabled = writesEnabled;
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "prompt-probe", version: "0.0.0" });
  await Promise.all([createServer(ctx).connect(serverTransport), client.connect(clientTransport)]);
  try {
    return await run(client);
  } finally {
    await client.close();
  }
}

async function render(client: Client, name: string, args = ARGS[name]): Promise<string> {
  const { messages } = await client.getPrompt({ name, arguments: args });
  expect(messages).toHaveLength(1);
  expect(messages[0]?.role).toBe("user");
  const content = messages[0]?.content as { type: string; text: string };
  expect(content.type).toBe("text");
  return content.text;
}

describe("MCP prompts", () => {
  test("the server offers exactly the three working loops", async () => {
    await withClient(false, async (client) => {
      const { prompts } = await client.listPrompts();
      expect(prompts.map((p) => p.name).toSorted()).toEqual(Object.keys(ARGS).toSorted());
    });
  });

  test("each prompt renders, carrying the caller's argument", async () => {
    await withClient(false, async (client) => {
      for (const [name, args] of Object.entries(ARGS)) {
        const text = await render(client, name);
        for (const value of Object.values(args)) expect(text).toContain(value);
      }
    });
  });

  test.each([false, true])(
    "every tool or field a prompt names is one the server declares or returns, writes %p",
    async (writesEnabled) => {
      await withClient(writesEnabled, async (client) => {
        const drift = (await client.callTool({ name: "check_drift", arguments: {} })) as {
          content: { text: string }[];
        };
        const replied = keys(JSON.parse(drift.content[0]!.text));
        const listed = JSON.stringify((await client.listTools()).tools);
        const declared = (name: string) => replied.has(name) || listed.includes(name);
        for (const name of Object.keys(ARGS)) {
          const text = await render(client, name);
          const quoted = [...text.matchAll(/`([a-z]+(?:[._][a-z]+)+)`/g)].map((m) => m[1]!);
          // The one page field the prompts name; every other identifier must be the server's.
          const unknown = quoted.filter(
            (q) => q !== "last_verified_revision" && !q.split(".").every(declared),
          );
          expect({ name, unknown }).toEqual({ name, unknown: [] });
        }
      });
    },
  );

  test("reverify names the write tool only when the server has it", async () => {
    expect(await withClient(true, (c) => render(c, "reverify_stale_pages"))).toContain(
      "`update_verified_revision`",
    );
    const readOnly = await withClient(false, (c) => render(c, "reverify_stale_pages"));
    expect(readOnly).not.toContain("update_verified_revision");
    expect(readOnly).toContain("by hand");
  });

  test("reverify records no revision on a cited-only page and pins the cite to drift's revision", async () => {
    const text = await withClient(false, (c) => render(c, "reverify_stale_pages"));
    expect(text).toContain("that is not in `cited_only`");
    expect(text).toContain("record no revision on them");
    expect(text).toContain("`expect_revision` set to the report's `current_revision`");
  });

  test("reverify with no source checks all of them", async () => {
    const text = await withClient(false, (c) => render(c, "reverify_stale_pages", {}));
    expect(text).toContain("Call `check_drift`. ");
  });

  test("a required argument is required", async () => {
    await withClient(false, async (client) => {
      await expect(client.getPrompt({ name: "ingest_source", arguments: {} })).rejects.toThrow();
    });
  });

  test("the setup skill names every prompt as the MCP form of its loops", () => {
    const skill = readFileSync(
      new URL("../../../skills/accreta-setup/SKILL.md", import.meta.url),
      "utf-8",
    );
    for (const name of Object.keys(ARGS)) expect(skill).toContain(`\`${name}\``);
  });
});
