import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, type AccretaConfig } from "../src/config.ts";
import { buildIndex } from "../src/index-db/build.ts";
import { openIndex, type Database } from "../src/index-db/db.ts";
import { findCanonical, findRelated, getPage } from "../src/query/page.ts";
import { searchPages } from "../src/query/search.ts";
import { lint } from "../src/query/lint.ts";

let root = "";
let indexPath = "";
let db: Database;

const config: AccretaConfig = {
  ...DEFAULT_CONFIG,
  knowledgeBase: "knowledge",
  pageTypes: ["concept", "note", "synthesis"],
  linkFields: ["related", "discussed_in"],
};

function writePage(relativePath: string, contents: string): void {
  const full = join(root, "knowledge", relativePath);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, contents, "utf-8");
}

function reindex(): void {
  buildIndex({ root, config, indexPath });
  db = openIndex(indexPath, { readonly: true });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "accreta-query-"));
  indexPath = join(root, ".index", "accreta.sqlite");
});

afterEach(() => {
  db?.close();
  rmSync(root, { recursive: true, force: true });
});

describe("searchPages", () => {
  beforeEach(() => {
    writePage(
      "concepts/forcing.md",
      "---\ntype: concept\nsource: ipcc\n---\n\n# Radiative forcing\n\nNet downward flux at the tropopause.\n",
    );
    writePage(
      "notes/misc.md",
      "---\ntype: note\nsource: other\n---\n\n# Misc\n\nUnrelated prose.\n",
    );
    reindex();
  });

  test("a body term finds its page", () => {
    const hits = searchPages(db, { query: "tropopause" });
    expect(hits.map((h) => h.path)).toEqual(["knowledge/concepts/forcing.md"]);
  });

  test("the snippet marks the match", () => {
    const [hit] = searchPages(db, { query: "tropopause" });
    expect(hit?.snippet).toContain("<<tropopause>>");
  });

  test("a type filter narrows the results", () => {
    expect(searchPages(db, { query: "flux OR prose", types: ["note"] }).map((h) => h.type)).toEqual(
      ["note"],
    );
  });

  test("a source filter narrows the results", () => {
    const hits = searchPages(db, { query: "flux OR prose", source: "ipcc" });
    expect(hits.map((h) => h.source)).toEqual(["ipcc"]);
  });

  test("a filter on a type no page uses returns nothing", () => {
    expect(searchPages(db, { query: "tropopause", types: ["nonexistent"] })).toEqual([]);
  });

  test("the limit is honoured and capped", () => {
    expect(searchPages(db, { query: "flux OR prose", limit: 1 })).toHaveLength(1);
  });
});

describe("getPage", () => {
  beforeEach(() => {
    writePage("concepts/forcing.md", "---\ntype: concept\n---\n\n# Radiative forcing\n\nBody.\n");
    reindex();
  });

  test("a page is found by its indexed path", () => {
    expect(getPage(db, "knowledge/concepts/forcing.md", config)?.title).toBe("Radiative forcing");
  });

  test("a page is found by wikilink target", () => {
    // A caller holding `[[concepts/forcing]]` is asking the same question as one
    // holding the path, and should not have to know which it has.
    expect(getPage(db, "concepts/forcing", config)?.title).toBe("Radiative forcing");
  });

  test("frontmatter comes back parsed", () => {
    expect(getPage(db, "concepts/forcing", config)?.frontmatter).toEqual({ type: "concept" });
  });

  test("a page that does not exist is null, not an error", () => {
    expect(getPage(db, "concepts/nothing", config)).toBeNull();
  });
});

describe("findRelated", () => {
  beforeEach(() => {
    writePage("a.md", "---\ntype: note\nrelated: [[b]]\n---\n\n# A\n\nMentions [[c]].\n");
    writePage("b.md", "---\ntype: note\n---\n\n# B\n");
    writePage("c.md", "---\ntype: note\n---\n\n# C\n");
    reindex();
  });

  test("inbound and outbound are distinguished", () => {
    // "what depends on X" and "what X depends on" are different questions and
    // must not collapse into one list.
    const fromA = findRelated(db, "a", config);
    expect(fromA.relations).toEqual([
      { path: "knowledge/b.md", kind: "related", direction: "outbound", type: "note", title: "B" },
    ]);

    const toB = findRelated(db, "b", config);
    expect(toB.relations).toEqual([
      { path: "knowledge/a.md", kind: "related", direction: "inbound", type: "note", title: "A" },
    ]);
  });

  test("inline mentions are excluded unless asked for", () => {
    expect(findRelated(db, "c", config).relations).toEqual([]);
    expect(findRelated(db, "c", config, { includeInline: true }).relations).toHaveLength(1);
  });

  test("a target with no page is reported as not existing", () => {
    const result = findRelated(db, "nowhere", config);
    expect(result.targetExists).toBe(false);
  });
});

describe("findCanonical", () => {
  beforeEach(() => {
    writePage(
      "concepts/forcing.md",
      '---\ntype: concept\naliases: ["climate forcing", "radiative flux change"]\ncanonical_source: "ipcc:ch07.md#L142"\n---\n\n# Radiative forcing\n\nBody.\n',
    );
    writePage("notes/other.md", "---\ntype: note\n---\n\n# Other\n\nMentions climate forcing.\n");
    reindex();
  });

  test("an exact title resolves", () => {
    const [match] = findCanonical(db, "Radiative forcing", config);
    expect(match?.path).toBe("knowledge/concepts/forcing.md");
    expect(match?.matchedOn).toBe("title");
  });

  test("an alias resolves to the same page", () => {
    // The name a question arrives under is rarely the name the page was filed
    // under.
    const [match] = findCanonical(db, "climate forcing", config);
    expect(match?.path).toBe("knowledge/concepts/forcing.md");
    expect(match?.matchedOn).toBe("alias");
  });

  test("a page merely containing the phrase is not a match", () => {
    const matches = findCanonical(db, "climate forcing", config);
    expect(matches.map((m) => m.path)).not.toContain("knowledge/notes/other.md");
  });

  test("an unknown term yields no matches", () => {
    expect(findCanonical(db, "not a concept here", config)).toEqual([]);
  });
});

describe("lint", () => {
  test("an unresolvable link is reported", () => {
    writePage("a.md", "---\ntype: note\n---\n\n# A\n\nSee [[../../../etc/passwd]].\n");
    reindex();
    const broken = lint(db, config).findings.filter((f) => f.kind === "broken-link");
    expect(broken).toHaveLength(1);
    expect(broken[0]?.path).toBe("knowledge/a.md");
  });

  test("a link to a page that does not exist is reported as dangling", () => {
    writePage("a.md", "---\ntype: note\nrelated: [[missing]]\n---\n\n# A\n");
    reindex();
    const dangling = lint(db, config).findings.filter((f) => f.kind === "dangling-link");
    expect(dangling).toHaveLength(1);
    expect(dangling[0]?.detail).toContain("knowledge/missing.md");
  });

  test("a page type outside the configured vocabulary is reported", () => {
    writePage("a.md", "---\ntype: invented\n---\n\n# A\n");
    reindex();
    const findings = lint(db, config).findings.filter((f) => f.kind === "unknown-page-type");
    expect(findings).toHaveLength(1);
  });

  test("pages without provenance or a verified revision are reported", () => {
    writePage("a.md", "---\ntype: note\n---\n\n# A\n");
    reindex();
    const kinds = lint(db, config).findings.map((f) => f.kind);
    expect(kinds).toContain("missing-provenance");
    expect(kinds).toContain("unverified-page");
  });

  test("a well-formed page produces no findings", () => {
    writePage(
      "a.md",
      '---\ntype: note\ncanonical_source: "ipcc:ch07.md#L1"\nlast_verified_revision: abc123\n---\n\n# A\n',
    );
    reindex();
    expect(lint(db, config).findings).toEqual([]);
  });
});
