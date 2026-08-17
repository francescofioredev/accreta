import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildIndex, DEFAULT_CONFIG, type AccretaConfig } from "@accreta/core";
import { createContext } from "../src/context.ts";
import { searchPagesTool } from "../src/tools.ts";

let root = "";

const config: AccretaConfig = {
  ...DEFAULT_CONFIG,
  knowledgeBase: "knowledge",
  pageTypes: ["note"],
};

// The default location, so no ACCRETA_INDEX_PATH override is needed. The env
// vars are process-wide and the CLI suite clears them, so a test that leaned on
// them would race with it.
const indexPath = () => join(root, ".accreta", "index.sqlite");

function writePage(name: string, contents: string): void {
  writeFileSync(join(root, "knowledge", name), contents, "utf-8");
}

function reindex(): void {
  buildIndex({ root, config, indexPath: indexPath() });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "accreta-context-"));
  mkdirSync(join(root, "knowledge"), { recursive: true });
  writeFileSync(
    join(root, "accreta.config.yaml"),
    "knowledge_base: knowledge\npage_types: [note]\n",
    "utf-8",
  );
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

test("a held context serves the new index after a rebuild swaps the file", () => {
  writePage("a.md", "---\ntype: note\n---\n\n# A\n\nalpha\n");
  reindex();

  const ctx = createContext(root);
  expect(searchPagesTool(ctx, { query: "alpha" }).count).toBe(1);

  // `update_verified_revision` writes markdown and asks the caller to reindex,
  // so a rebuild mid-session is the documented path, not an edge case. Before
  // the reopen this threw "disk I/O error" for the life of the process.
  for (let i = 0; i < 5; i++) {
    writePage(`gen${i}.md`, `---\ntype: note\n---\n\n# G${i}\n\ngeneration${i}\n`);
    reindex();
    expect(searchPagesTool(ctx, { query: `generation${i}` }).count).toBe(1);
  }

  expect(searchPagesTool(ctx, { query: "alpha" }).count).toBe(1);
});

test("a rebuild does not replace the context the server captured", () => {
  writePage("a.md", "---\ntype: note\n---\n\n# A\n\nalpha\n");
  reindex();

  // The server registers its tools against one context object and never asks
  // for another, so the reopen has to happen behind a stable identity.
  const ctx = createContext(root);
  const { config: before, root: rootBefore } = ctx;

  writePage("b.md", "---\ntype: note\n---\n\n# B\n\nbeta\n");
  reindex();
  expect(searchPagesTool(ctx, { query: "beta" }).count).toBe(1);

  expect(ctx.config).toBe(before);
  expect(ctx.root).toBe(rootBefore);
});
