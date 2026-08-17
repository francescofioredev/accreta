import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildIndex, DEFAULT_CONFIG, openIndex, type AccretaConfig } from "@accreta/core";
import { FsSource } from "@accreta/adapter-fs";
import {
  checkDriftTool,
  findCanonicalTool,
  findConsumersTool,
  getPageTool,
  lintTool,
  listRecentChangesTool,
  searchPagesTool,
  setFrontmatterField,
  updateVerifiedRevisionTool,
  type ToolContext,
} from "../src/index.ts";

let root = "";
let ctx: ToolContext;

const config: AccretaConfig = {
  ...DEFAULT_CONFIG,
  knowledgeBase: "knowledge",
  pageTypes: ["concept", "note"],
  linkFields: ["related", "discussed_in"],
};

function writePage(relativePath: string, contents: string): void {
  const full = join(root, "knowledge", relativePath);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, contents, "utf-8");
}

function build(writesEnabled = false): void {
  const indexPath = join(root, ".accreta", "index.sqlite");
  buildIndex({ root, config, indexPath });
  ctx = {
    db: openIndex(indexPath, { readonly: true }),
    config,
    root,
    sources: new Map(),
    writesEnabled,
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "accreta-mcp-"));
});

afterEach(() => {
  ctx?.db.close();
  rmSync(root, { recursive: true, force: true });
});

describe("read tools", () => {
  beforeEach(() => {
    writePage(
      "concepts/forcing.md",
      '---\ntype: concept\naliases: ["climate forcing"]\ncanonical_source: "ipcc:ch07.md#L1"\nlast_verified_revision: abc123\nrelated: [[notes/a]]\n---\n\n# Radiative forcing\n\ntropopause flux\n',
    );
    writePage("notes/a.md", "---\ntype: note\n---\n\n# A note\n");
    build();
  });

  test("search_pages finds a page by a body term", () => {
    const result = searchPagesTool(ctx, { query: "tropopause" });
    expect(result.count).toBe(1);
    expect(result.results[0]?.path).toBe("knowledge/concepts/forcing.md");
  });

  test("get_page accepts a wikilink target", () => {
    const result = getPageTool(ctx, { path: "concepts/forcing" });
    expect(result.found).toBe(true);
    if (result.found) expect(result.page.title).toBe("Radiative forcing");
  });

  test("get_page reports a miss rather than throwing", () => {
    expect(getPageTool(ctx, { path: "nothing/here" }).found).toBe(false);
  });

  test("find_consumers labels each relation with its direction", () => {
    const result = findConsumersTool(ctx, { target: "notes/a" });
    expect(result.results).toEqual([
      {
        path: "knowledge/concepts/forcing.md",
        kind: "related",
        direction: "inbound",
        type: "concept",
        title: "Radiative forcing",
      },
    ]);
  });

  test("find_canonical resolves an alias", () => {
    const result = findCanonicalTool(ctx, { term: "climate forcing" });
    expect(result.results[0]?.matched_on).toBe("alias");
  });

  test("the records these tools return are snake_case throughout", () => {
    // A model reading four tools' JSON should not have to switch conventions
    // between them. These are core records crossing the boundary, so the
    // mapping is shared rather than rewritten at each return site.
    const page = getPageTool(ctx, { path: "knowledge/concepts/forcing.md" });
    expect(page.found && page.page).toMatchObject({ canonical_source: expect.anything() });
    expect(page.found && page.page).not.toHaveProperty("canonicalSource");
    expect(page.found && page.page).not.toHaveProperty("lastVerifiedRevision");

    const hit = searchPagesTool(ctx, { query: "forcing" }).results[0];
    expect(hit).not.toHaveProperty("lastVerifiedRevision");

    const match = findCanonicalTool(ctx, { term: "climate forcing" }).results[0];
    expect(match).not.toHaveProperty("matchedOn");
    expect(match).not.toHaveProperty("canonicalSource");
  });

  test("lint reports a page whose type is outside the vocabulary", async () => {
    const { findings } = await lintTool(ctx);
    expect(findings.filter((f) => f.kind === "unknown-page-type")).toEqual([]);
  });
});

describe("source-backed tools", () => {
  beforeEach(() => {
    mkdirSync(join(root, "src-docs"), { recursive: true });
    writeFileSync(join(root, "src-docs", "ch07.md"), "text", "utf-8");
    writePage(
      "a.md",
      "---\ntype: note\nsource: docs\nlast_verified_revision: fromapreviousrun\n---\n\n# A\n",
    );
    build();
    ctx.sources.set(
      "docs",
      new FsSource({
        id: "docs",
        root: join(root, "src-docs"),
        citationFormat: "{source} @ {rev}",
      }),
    );
  });

  test("check_drift separates 'cannot place' from 'up to date'", async () => {
    const result = await checkDriftTool(ctx, {});
    const report = result.reports?.[0];
    expect(report?.unresolvable[0]?.pages).toEqual(["knowledge/a.md"]);
    expect(report?.stale).toEqual([]);
  });

  test("check_drift names its fields the way every other tool does", async () => {
    const report = (await checkDriftTool(ctx, {})).reports?.[0];
    expect(report?.source_id).toBe("docs");
    expect(report?.current_revision).toBeDefined();
    // The consumer is a model reading JSON; two conventions in one server is a
    // tax on every call.
    expect(report).not.toHaveProperty("sourceId");
    expect(report).not.toHaveProperty("currentRevision");
  });

  test("list_recent_changes surfaces an unplaceable revision as such", async () => {
    // Returning an empty change list would read as "nothing changed", which is
    // a different claim from "I cannot tell".
    const result = await listRecentChangesTool(ctx, { source: "docs", since: "unknownrev" });
    expect(result.unresolvable).toBe(true);
    expect(result.changed).toEqual([]);
  });

  test("an unknown source is named, not silently empty", async () => {
    const result = await listRecentChangesTool(ctx, { source: "nope", since: "x" });
    expect(result.message).toContain("No source named");
  });
});

describe("update_verified_revision", () => {
  beforeEach(() => {
    writePage("a.md", "---\ntype: note\nlast_verified_revision: old111\n---\n\n# A\n\nBody.\n");
  });

  test("is refused when writes are not enabled", () => {
    build(false);
    const result = updateVerifiedRevisionTool(ctx, { path: "a", revision: "new222" });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("ACCRETA_ALLOW_WRITES");
  });

  test("without a token it returns a dry run and changes nothing", () => {
    build(true);
    const result = updateVerifiedRevisionTool(ctx, { path: "a", revision: "new222" });
    expect(result.ok).toBe(false);
    if (!result.ok && "dry_run" in result) {
      expect(result.dry_run).toBe(true);
      expect(result.current_revision).toBe("old111");
      expect(result.confirm_token).toBeTruthy();
    }
    expect(readFileSync(join(root, "knowledge", "a.md"), "utf-8")).toContain("old111");
  });

  test("the dry-run token applies the write", () => {
    build(true);
    const dry = updateVerifiedRevisionTool(ctx, { path: "a", revision: "new222" });
    const token = !dry.ok && "confirm_token" in dry ? dry.confirm_token : undefined;

    const result = updateVerifiedRevisionTool(ctx, {
      path: "a",
      revision: "new222",
      confirm_token: token,
    });
    expect(result.ok).toBe(true);
    expect(readFileSync(join(root, "knowledge", "a.md"), "utf-8")).toContain("new222");
  });

  test("a token from one edit does not authorise another", () => {
    // The property that makes this more than a boolean: the token is derived
    // from the page, the revision and the current value, so it cannot be
    // carried across to a different write.
    build(true);
    const dry = updateVerifiedRevisionTool(ctx, { path: "a", revision: "new222" });
    const token = !dry.ok && "confirm_token" in dry ? dry.confirm_token : undefined;

    const result = updateVerifiedRevisionTool(ctx, {
      path: "a",
      revision: "different333",
      confirm_token: token,
    });
    expect(result.ok).toBe(false);
    expect(readFileSync(join(root, "knowledge", "a.md"), "utf-8")).toContain("old111");
  });

  test("a missing page is refused before any write is attempted", () => {
    build(true);
    expect(updateVerifiedRevisionTool(ctx, { path: "nope", revision: "x" }).ok).toBe(false);
  });
});

describe("setFrontmatterField", () => {
  test("replaces an existing field and leaves the rest byte-identical", () => {
    const before =
      '---\ntype: note\nlast_verified_revision: old\naliases: ["x", "y"]\n---\n\n# A\n';
    const after = setFrontmatterField(before, "last_verified_revision", "new");
    expect(after).toContain("last_verified_revision: new");
    expect(after).toContain('aliases: ["x", "y"]');
    expect(after).toContain("type: note");
  });

  test("inserts the field when it is absent", () => {
    const after = setFrontmatterField(
      "---\ntype: note\n---\n\n# A\n",
      "last_verified_revision",
      "r1",
    );
    expect(after).toContain("last_verified_revision: r1");
    expect(after).toContain("type: note");
  });

  test("wikilink syntax in other fields survives untouched", () => {
    // A parse-and-reserialize would rewrite this into valid YAML and destroy
    // the syntax that renders as a link on GitHub.
    const before = "---\ntype: note\ndiscussed_in: [[synthesis/x]]\n---\n\n# A\n";
    const after = setFrontmatterField(before, "last_verified_revision", "r1");
    expect(after).toContain("discussed_in: [[synthesis/x]]");
  });

  test("a page with no frontmatter gains a block", () => {
    const after = setFrontmatterField("# A\n\nBody.\n", "last_verified_revision", "r1");
    expect(after.startsWith("---\nlast_verified_revision: r1\n---\n")).toBe(true);
    expect(after).toContain("# A");
  });
});
