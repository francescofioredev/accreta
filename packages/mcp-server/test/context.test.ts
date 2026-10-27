import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildIndex,
  DEFAULT_CONFIG,
  StaleIndexError,
  type AccretaConfig,
  type Database,
  type LocationVerdict,
  type SourceAdapter,
} from "@accreta/core";
import { createContext } from "../src/context.ts";
import {
  checkDriftTool,
  lintTool,
  listRecentChangesTool,
  searchPagesTool,
  type PinnedIndex,
  type ToolContext,
} from "../src/tools.ts";

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

test("a half-declared delegated source does not stop the server, and lint and drift name it", async () => {
  mkdirSync(join(root, "sources", "docs"), { recursive: true });
  writeFileSync(join(root, "sources", "docs", "a.md"), "one\n", "utf-8");
  writeFileSync(join(root, "sources", "docs.yaml"), "id: docs\ntype: fs\nroot: sources/docs\n");
  writeFileSync(
    join(root, "sources", "design.yaml"),
    "id: design\ntype: delegated\nvia: notion\nscope: |\n",
  );
  writePage("a.md", "---\ntype: note\n---\n\n# A\n");
  reindex();

  const ctx = createContext(root);
  expect([...ctx.sources.keys()]).toEqual(["docs"]);

  const file = join("sources", "design.yaml");
  const lint = await lintTool(ctx);
  expect(lint.findings).toContainEqual({
    kind: "unloaded-source",
    path: file,
    detail: expect.stringContaining("`scope`"),
  });
  const drift = await checkDriftTool(ctx, {});
  expect(drift.reports.map((r) => r.source_id)).toEqual(["docs"]);
  expect(drift.unloaded_sources).toEqual([
    { file, id: "design", reason: expect.stringContaining("`scope`"), pages: 0 },
  ]);

  // Asked by id, it is a declared source that did not load, not an unknown name.
  const one = await checkDriftTool(ctx, { source: "design" });
  expect(one.message).toStartWith(`Source "design" is declared in ${file} but did not load:`);
  expect(one.message).toContain("`scope`");
  const changes = await listRecentChangesTool(ctx, { source: "design", since: "r1" });
  expect(changes.message).toBe(one.message);
});

test("two declarations sharing an id do not stop the server, and drift names both", async () => {
  mkdirSync(join(root, "sources", "docs"), { recursive: true });
  writeFileSync(join(root, "sources", "docs", "a.md"), "one\n", "utf-8");
  writeFileSync(join(root, "sources", "docs.yaml"), "id: docs\ntype: fs\nroot: sources/docs\n");
  writeFileSync(join(root, "sources", "a.yaml"), "id: notes\ntype: fs\nroot: one\n");
  writeFileSync(join(root, "sources", "b.yaml"), "id: notes\ntype: fs\nroot: two\n");
  writePage("a.md", "---\ntype: note\nsource: notes\n---\n\n# A\n");
  reindex();

  const ctx = createContext(root);
  expect([...ctx.sources.keys()]).toEqual(["docs"]);

  const [a, b] = [join("sources", "a.yaml"), join("sources", "b.yaml")];
  const drift = await checkDriftTool(ctx, { source: "notes" });
  expect(drift.unloaded_sources).toEqual([
    { file: a, id: "notes", reason: expect.stringContaining(`also declared in ${b}`), pages: 1 },
    { file: b, id: "notes", reason: expect.stringContaining(`also declared in ${a}`), pages: 1 },
  ]);
  expect(drift.message).toStartWith(`Source "notes" is declared in ${a} but did not load:`);
  expect(drift.message).toContain(`also declared in ${b}`);
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

function gate(): { opened: Promise<void>; open: () => void } {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { opened, open };
}

function adapter(
  id: string,
  hooks: {
    revision?: () => Promise<string>;
    changedSince?: () => Promise<string[]>;
    locate?: () => Promise<LocationVerdict>;
  } = {},
): SourceAdapter {
  return {
    id,
    revision: hooks.revision ?? (async () => "r1"),
    changedSince: hooks.changedSince ?? (async () => ["x.md"]),
    locate: hooks.locate ?? (async () => ({ verdict: "found" })),
    citation: (path) => `${id}:${path}`,
    pinRevision: () => {},
  };
}

function isOpen(db: Database): boolean {
  try {
    db.prepare("SELECT 1").get();
    return true;
  } catch (error) {
    return !/not open/.test(String(error));
  }
}

// Every handle a call pins, in order, so a test can check each one was released.
function recordPins(ctx: ToolContext): Database[] {
  const pin = ctx.pin!.bind(ctx);
  const pinned: Database[] = [];
  ctx.pin = () => {
    const held = pin();
    pinned.push(held.db);
    return held;
  };
  return pinned;
}

test("check_drift reruns on the rebuilt index when a rebuild lands mid-call", async () => {
  writePage("a.md", "---\ntype: note\n---\n\n# A\n\nalpha\n");
  reindex();

  const ctx = createContext(root);
  const pinned = recordPins(ctx);
  const entered = gate();
  const blocked = gate();
  const held = async () => {
    entered.open();
    await blocked.opened;
    return "r1";
  };
  ctx.sources.set("held", adapter("held", { revision: held }));
  ctx.sources.set("docs", adapter("docs"));

  const call = checkDriftTool(ctx, {});
  await entered.opened;
  writePage(
    "b.md",
    "---\ntype: note\nsource: docs\nlast_verified_revision: r0\n---\n\n# B\n\nbeta\n",
  );
  reindex();
  // A new reader gets the rebuilt index at once: only the old handle's close waits.
  expect(searchPagesTool(ctx, { query: "beta" }).count).toBe(1);
  expect(isOpen(pinned[0]!)).toBe(true);
  blocked.open();

  // b.md exists only in the rebuilt index, so finding it stale proves the report came from there.
  const drift = await call;
  expect(drift.reports.map((r) => [r.source_id, r.stale.map((s) => s.pages)])).toEqual([
    ["held", []],
    ["docs", [["knowledge/b.md"]]],
  ]);
  expect(pinned).toHaveLength(2);
  expect(isOpen(pinned[0]!)).toBe(false);
});

test("check_drift gives up when the index is rebuilt during its rerun too", async () => {
  writePage("a.md", "---\ntype: note\n---\n\n# A\n\nalpha\n");
  reindex();

  const ctx = createContext(root);
  const pinned = recordPins(ctx);
  const rebuilding = async () => {
    reindex();
    expect(searchPagesTool(ctx, { query: "alpha" }).count).toBe(1);
    return "r1";
  };
  ctx.sources.set("held", adapter("held", { revision: rebuilding }));

  await expect(checkDriftTool(ctx, {})).rejects.toThrow(
    "The index was rebuilt twice while check_drift ran. Run check_drift again.",
  );
  expect(pinned).toHaveLength(2);
  expect(pinned.filter(isOpen)).toEqual([]);
});

test("lint holds its index while a source blocks, then reruns on the rebuilt one", async () => {
  writePage("a.md", '---\ntype: note\ncanonical_source: "held:x.md"\n---\n\n# A\n');
  reindex();

  const ctx = createContext(root);
  const pinned = recordPins(ctx);
  const entered = gate();
  const blocked = gate();
  const locate = async (): Promise<LocationVerdict> => {
    entered.open();
    await blocked.opened;
    return { verdict: "found" };
  };
  ctx.sources.set("held", adapter("held", { locate }));

  const call = lintTool(ctx);
  await entered.opened;
  writePage("b.md", "---\ntype: note\n---\n\n# B\n\nbeta\n");
  reindex();
  expect(searchPagesTool(ctx, { query: "beta" }).count).toBe(1);
  expect(isOpen(pinned[0]!)).toBe(true);
  blocked.open();

  expect((await call).pages_checked).toBe(2);
  expect(isOpen(pinned[0]!)).toBe(false);
});

test("a rebuild closes every old handle that no call still holds", () => {
  writePage("a.md", "---\ntype: note\n---\n\n# A\n");
  reindex();

  const ctx = createContext(root);
  const seen = new Set<Database>([ctx.db]);
  const held: PinnedIndex[] = [];
  for (let i = 0; i < 6; i++) {
    const pin = ctx.pin!();
    if (i % 2 === 0) held.push(pin);
    else pin.release();
    writePage(`gen${i}.md`, `---\ntype: note\n---\n\n# G${i}\n`);
    reindex();
    seen.add(ctx.db);
  }

  const open = () => [...seen].filter(isOpen);
  expect(seen.size).toBe(7);
  expect(open()).toEqual([...held.map((pin) => pin.db), ctx.db]);
  for (const pin of held) pin.release();
  held[0]?.release();
  expect(open()).toEqual([ctx.db]);
});

test("a call that throws still releases the index it pinned", async () => {
  // A failing revision is reported, not thrown (#362), so the diff fails instead.
  writePage(
    "a.md",
    "---\ntype: note\nsource: held\nlast_verified_revision: r0\n---\n\n# A\n\nalpha\n",
  );
  reindex();

  const ctx = createContext(root);
  const pin = ctx.pin!.bind(ctx);
  let pinned: Database | undefined;
  ctx.pin = () => {
    const held = pin();
    pinned = held.db;
    return held;
  };
  const entered = gate();
  const blocked = gate();
  const down = async (): Promise<string[]> => {
    entered.open();
    await blocked.opened;
    throw new Error("source down");
  };
  ctx.sources.set("held", adapter("held", { changedSince: down }));

  const call = checkDriftTool(ctx, {});
  await entered.opened;
  reindex();
  expect(searchPagesTool(ctx, { query: "alpha" }).count).toBe(1);
  expect(isOpen(pinned!)).toBe(true);
  blocked.open();

  await expect(call).rejects.toThrow("source down");
  expect(isOpen(pinned!)).toBe(false);
});

test("a reopen after a swap refuses an index of another format", () => {
  writePage("a.md", "---\ntype: note\n---\n\n# A\n\nalpha\n");
  reindex();
  const ctx = createContext(root);
  expect(searchPagesTool(ctx, { query: "alpha" }).count).toBe(1);

  const older = `${indexPath()}.older`;
  buildIndex({ root, config, indexPath: older });
  const writable = new DatabaseSync(older);
  writable.exec("DELETE FROM meta WHERE key = 'index_format'");
  writable.close();
  renameSync(older, indexPath());

  expect(() => ctx.db).toThrow(StaleIndexError);

  reindex();
  expect(searchPagesTool(ctx, { query: "alpha" }).count).toBe(1);
});

// Windows refuses to unlink a file SQLite holds open.
test.skipIf(process.platform === "win32")(
  "an index that vanishes after the first open keeps the handle rather than failing",
  () => {
    writePage("a.md", "---\ntype: note\n---\n\n# A\n\nalpha\n");
    reindex();
    const ctx = createContext(root);
    const first = ctx.db;

    rmSync(indexPath());
    expect(ctx.db).toBe(first);
  },
);

// Windows and root ignore the mode bits, so the file stays readable there.
test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
  "an index that cannot be opened fails the call with the remedy, and a rebuild mends it",
  () => {
    writePage("a.md", "---\ntype: note\n---\n\n# A\n\nalpha\n");
    reindex();
    chmodSync(indexPath(), 0o000);

    const ctx = createContext(root);
    expect(() => ctx.db).toThrow(`Cannot open the index at ${indexPath()}`);
    expect(() => ctx.db).toThrow("run `accreta reindex`");

    reindex();
    expect(searchPagesTool(ctx, { query: "alpha" }).count).toBe(1);
  },
);

test("an index core opens but cannot read names the remedy once", () => {
  mkdirSync(join(root, ".accreta"), { recursive: true });
  writeFileSync(
    indexPath(),
    "not a database, but long enough to have a header to reject".repeat(4),
  );

  const ctx = createContext(root);
  let message = "";
  try {
    void ctx.db;
  } catch (error) {
    message = (error as Error).message;
  }
  expect(message).toContain("file is not a database");
  expect(message.split("accreta reindex")).toHaveLength(2);
});
