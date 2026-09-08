import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, type AccretaConfig } from "../src/config.ts";
import { buildIndex } from "../src/index-db/build.ts";
import { openIndex, type Database } from "../src/index-db/db.ts";
import { findCanonical, findRelated, getPage } from "../src/query/page.ts";
import { searchPages } from "../src/query/search.ts";
import { lint, lintCitations } from "../src/query/lint.ts";
import {
  parseCitation,
  parseLineLocator,
  type LocationVerdict,
  type SourceAdapter,
} from "../src/source/adapter.ts";

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

  test("a declared alias is searchable, because the index keeps it", () => {
    // Measured, not assumed: blank the FTS aliases column and this query returns
    // nothing at all, not a worse rank. The editorial work of declaring an alias
    // is signal a curated corpus has, and discarding it at index time is how a
    // system argues itself into needing embeddings.
    writePage(
      "concepts/sensitivity.md",
      '---\ntype: concept\naliases: ["ECS", "equilibrium climate sensitivity"]\n---\n\n# Climate sensitivity\n\nWarming after doubling.\n',
    );
    reindex();
    expect(searchPages(db, { query: "ECS" }).map((h) => h.path)).toEqual([
      "knowledge/concepts/sensitivity.md",
    ]);
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

  // Before this kind existed, such a page produced three findings that each
  // described a symptom — no type, no provenance, no verified revision — and
  // none that named the cause. An author reading "no canonical_source" would go
  // and add a field that is already there.
  test("a page whose frontmatter would not load is told why", () => {
    writePage(
      "a.md",
      '---\ntype: note\ncanonical_source: "ipcc:ch07.md#L1"\nlast_verified_revision: abc123\nbroken: [unclosed\n---\n\n# A\n',
    );
    reindex();

    const findings = lint(db, config).findings.filter((f) => f.path === "knowledge/a.md");
    const cause = findings.filter((f) => f.kind === "unparseable-frontmatter");
    expect(cause).toHaveLength(1);
    expect(cause[0]?.detail).toContain("discarded");

    // Reported alongside the symptoms, not instead of them: the page really
    // does lack a type and provenance once its frontmatter is gone.
    const kinds = findings.map((f) => f.kind);
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

describe("parseCitation", () => {
  test("a source, a path and a range", () => {
    expect(parseCitation("ipcc:ch07.md#L142-L160")).toEqual({
      sourceId: "ipcc",
      path: "ch07.md",
      locator: "L142-L160",
    });
  });

  test("a locator is carried through without being understood", () => {
    // The grammar does not know what a block id is, and does not need to: only
    // the source it names can say whether it addresses anything.
    expect(parseCitation("design-docs:2f1a4b#block-a1b2c3")).toEqual({
      sourceId: "design-docs",
      path: "2f1a4b",
      locator: "block-a1b2c3",
    });
  });

  test("a citation may name no locator at all", () => {
    expect(parseCitation("ipcc:ch07.md")).toEqual({ sourceId: "ipcc", path: "ch07.md" });
  });

  test("nested paths survive", () => {
    expect(parseCitation("s:a/b/c.md#L1")?.path).toBe("a/b/c.md");
  });

  test("a malformed pointer is null rather than a throw", () => {
    // Reported as a finding by the caller; a lint pass should not explode on
    // a value a model wrote.
    for (const bad of ["", "no-colon", "s:", ":path", "s:p#"]) {
      expect(parseCitation(bad)).toBeNull();
    }
  });

  test("a nonsensical range parses, because the grammar is not the judge", () => {
    // `L9-L2` is a well-formed pointer at nothing. It is the source that says
    // so, as a finding, not the parser as a syntax error.
    expect(parseCitation("s:p#L9-L2")).toEqual({ sourceId: "s", path: "p", locator: "L9-L2" });
  });
});

describe("parseLineLocator", () => {
  test("a range, and a single line as a range of one", () => {
    expect(parseLineLocator("L142-L160")).toEqual([142, 160]);
    expect(parseLineLocator("L142")).toEqual([142, 142]);
  });

  test("a pointer at nothing is null", () => {
    for (const bad of ["L0", "L9-L2", "block-a1b2c3", "142", ""]) {
      expect(parseLineLocator(bad)).toBeNull();
    }
  });
});

/** A file-backed source, answering the way `fs` and `git` do. */
function locateIn(files: Record<string, string>, path: string, locator?: string): LocationVerdict {
  const text = files[path];
  if (text === undefined) {
    return { verdict: "missing", part: "path", detail: `${path} does not exist` };
  }
  if (locator === undefined) return { verdict: "found" };
  const range = parseLineLocator(locator);
  if (!range) {
    return { verdict: "missing", part: "locator", detail: `"${locator}" is not a line range` };
  }
  const lines = text.split("\n").length;
  return range[1] > lines
    ? {
        verdict: "missing",
        part: "locator",
        detail: `cites L${range[0]}-L${range[1]} but ${path} has ${lines} line(s)`,
      }
    : { verdict: "found" };
}

function source(id: string, files: Record<string, string>): SourceAdapter {
  return {
    id,
    revision: async () => "rev",
    changedSince: async () => [],
    locate: async (path, locator) => locateIn(files, path, locator),
    citation: () => "",
    pinRevision: () => {},
  };
}

const sources = (adapter: SourceAdapter) => new Map([[adapter.id, adapter]]);

describe("lintCitations", () => {
  const tenLines = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join("\n");

  test("a citation whose path does not exist in the source is reported", async () => {
    writePage("a.md", '---\ntype: note\ncanonical_source: "s:gone.md#L1"\n---\n\n# A\n');
    reindex();
    const { findings } = await lintCitations(db, sources(source("s", { "there.md": tenLines })));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.kind).toBe("citation-path-missing");
    expect(findings[0]?.path).toBe("knowledge/a.md");
  });

  test("a locator past the end of the file is reported", async () => {
    // The issue's own reproduction: a pointer into a file that exists, at a
    // line that does not.
    writePage("a.md", '---\ntype: note\ncanonical_source: "s:doc.md#L99999"\n---\n\n# A\n');
    reindex();
    const { findings } = await lintCitations(db, sources(source("s", { "doc.md": tenLines })));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.kind).toBe("citation-locator-missing");
    expect(findings[0]?.detail).toContain("10 line(s)");
  });

  test("a range that fits the file is not reported", async () => {
    writePage("a.md", '---\ntype: note\ncanonical_source: "s:doc.md#L2-L9"\n---\n\n# A\n');
    reindex();
    const { findings } = await lintCitations(db, sources(source("s", { "doc.md": tenLines })));
    expect(findings).toEqual([]);
  });

  test("a citation naming an unconfigured source is not a finding", async () => {
    // Without an adapter the pointer cannot be checked, and reporting it would
    // dress "I did not look" up as "I found something". Working against a
    // subset of the declared sources is normal.
    writePage("a.md", '---\ntype: note\ncanonical_source: "elsewhere:doc.md#L1"\n---\n\n# A\n');
    reindex();
    const { findings } = await lintCitations(db, sources(source("s", { "doc.md": tenLines })));
    expect(findings).toEqual([]);
  });

  test("a citation that does not parse is reported rather than thrown", async () => {
    writePage("a.md", '---\ntype: note\ncanonical_source: "not a pointer"\n---\n\n# A\n');
    reindex();
    const { findings } = await lintCitations(db, sources(source("s", {})));
    expect(findings[0]?.kind).toBe("unparseable-citation");
  });

  test("a page citing nothing is not checked here", async () => {
    // `lint` already reports missing provenance; reporting it twice would make
    // one gap look like two.
    writePage("a.md", "---\ntype: note\n---\n\n# A\n");
    reindex();
    const report = await lintCitations(db, sources(source("s", {})));
    expect(report.findings).toEqual([]);
    expect(report.pagesChecked).toBe(0);
  });

  test("one location cited by many pages is asked about once", async () => {
    let asked = 0;
    const counting: SourceAdapter = {
      ...source("s", { "doc.md": tenLines }),
      locate: async (path, locator) => {
        asked++;
        return locateIn({ "doc.md": tenLines }, path, locator);
      },
    };
    for (const name of ["a", "b", "c"]) {
      writePage(
        `${name}.md`,
        `---\ntype: note\ncanonical_source: "s:doc.md#L1"\n---\n\n# ${name}\n`,
      );
    }
    reindex();
    await lintCitations(db, sources(counting));
    expect(asked).toBe(1);
  });

  test("a well-formed pointer at an impossible range is a locator finding", async () => {
    // Not `unparseable-citation`: the pointer is shaped correctly and names a
    // real file. What is wrong is where inside it points, and only the source
    // can say so.
    writePage("a.md", '---\ntype: note\ncanonical_source: "s:doc.md#L9-L2"\n---\n\n# A\n');
    reindex();
    const { findings } = await lintCitations(db, sources(source("s", { "doc.md": tenLines })));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.kind).toBe("citation-locator-missing");
  });

  test("a source that cannot check is counted, not reported", async () => {
    // "I did not look" must not read as "I found something", so an unknown
    // verdict produces a number rather than a finding.
    const opaque: SourceAdapter = {
      ...source("s", {}),
      locate: async () => ({ verdict: "unknown", detail: "only the agent can reach this" }),
    };
    writePage("a.md", '---\ntype: note\ncanonical_source: "s:anything#block-1"\n---\n\n# A\n');
    reindex();
    const report = await lintCitations(db, sources(opaque));
    expect(report.findings).toEqual([]);
    expect(report.citationsUnchecked).toBe(1);
  });

  test("an adapter that throws leaves the citation unchecked, not broken", async () => {
    // A network that is down says nothing about whether a citation is correct.
    const failing: SourceAdapter = {
      ...source("s", {}),
      locate: async () => {
        throw new Error("connection refused");
      },
    };
    writePage("a.md", '---\ntype: note\ncanonical_source: "s:doc.md#L1"\n---\n\n# A\n');
    reindex();
    const report = await lintCitations(db, sources(failing));
    expect(report.findings).toEqual([]);
    expect(report.citationsUnchecked).toBe(1);
  });
});
