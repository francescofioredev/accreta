import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, type AccretaConfig } from "../src/config.ts";
import { buildIndex } from "../src/index-db/build.ts";
import { openIndex, type Database } from "../src/index-db/db.ts";
import { findCanonical, findRelated, getPage } from "../src/query/page.ts";
import { searchPages } from "../src/query/search.ts";
import { identifiersIn } from "../src/identifiers.ts";
import { lint, lintCitations } from "../src/query/lint.ts";
import { countPagesCiting } from "../src/query/citing.ts";
import { requireTable, StaleIndexError } from "../src/query/tables.ts";
import {
  countLines,
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
  // node:sqlite throws on a second close(), and the next test may open nothing.
  db = undefined as unknown as Database;
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
    const hits = searchPages(db, { query: "flux OR prose", syntax: "fts5", types: ["note"] });
    expect(hits.map((h) => h.type)).toEqual(["note"]);
  });

  test("a source filter narrows the results", () => {
    const hits = searchPages(db, { query: "flux OR prose", syntax: "fts5", source: "ipcc" });
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
    expect(searchPages(db, { query: "flux OR prose", syntax: "fts5", limit: 1 })).toHaveLength(1);
  });
});

describe("searchPages on a plain query", () => {
  const paths = (query: string, syntax?: "plain" | "fts5") =>
    searchPages(db, { query, syntax })
      .map((h) => h.path.replace("knowledge/notes/", ""))
      .toSorted();

  beforeEach(() => {
    const note = (name: string, body: string) =>
      writePage(`notes/${name}.md`, `---\ntype: note\n---\n\n# ${name}\n\n${body}\n`);
    note("fired", "Fired pieces are not porous.");
    note("raw", "Unfired pieces absorb water.");
    note("finish", "Use glaze or slip on the rim.");
    note("rim", "The rim takes glaze.");
    note("wedge", "Wedge and knead the clay.");
    note("knead", "Knead the clay, then wedge it.");
    reindex();
  });

  test("an uppercase NOT is a word, not a negation", () => {
    expect(paths("pieces NOT porous")).toEqual(["fired.md"]);
  });

  test("an uppercase OR is a word, not a union", () => {
    expect(paths("glaze OR slip")).toEqual(["finish.md"]);
  });

  test("an uppercase AND is a word, not a conjunction", () => {
    expect(paths("wedge AND knead")).toEqual(["wedge.md"]);
  });

  test("lowercase operators are words too", () => {
    expect(paths("pieces not porous")).toEqual(["fired.md"]);
    expect(paths("glaze or slip")).toEqual(["finish.md"]);
    expect(paths("wedge and knead")).toEqual(["wedge.md"]);
  });

  test("a query that is only an operator searches for that word", () => {
    expect(paths("NOT")).toEqual(["fired.md"]);
    expect(paths("OR")).toEqual(["finish.md"]);
    expect(paths("AND")).toEqual(["wedge.md"]);
    expect(paths("NEAR")).toEqual([]);
  });

  test("a double-quoted phrase stays a phrase", () => {
    expect(paths('"not porous"')).toEqual(["fired.md"]);
    expect(paths('"porous not"')).toEqual([]);
    expect(paths('fired "NOT porous"')).toEqual(["fired.md"]);
  });

  test("FTS5 syntax characters never reach the caller as a syntax error", () => {
    const queries = [
      '"',
      '""',
      'glaze"',
      '"takes glaze',
      "*",
      "**",
      "glaze*",
      "glaze**",
      '"rim"*',
      "-*",
      "glaze\0",
      "a\0b",
      '"a\0b"',
      "-",
      "-porous",
      ":",
      "title:glaze",
      "(",
      "(slip",
      "slip)",
      "^rim",
      "+",
      "NEAR(glaze slip)",
      "{title}: glaze",
      "   ",
    ];
    for (const query of queries) {
      expect(() => searchPages(db, { query })).not.toThrow();
    }
    expect(paths("-porous")).toEqual(["fired.md"]);
    expect(paths("(slip")).toEqual(["finish.md"]);
    expect(paths('"takes glaze')).toEqual(["rim.md"]);
    expect(paths("glaze\0")).toEqual(["finish.md", "rim.md"]);
    expect(paths("   ")).toEqual([]);
  });

  test("a trailing * is still a prefix search, and a bare * matches nothing", () => {
    expect(paths("glaz*")).toEqual(["finish.md", "rim.md"]);
    expect(paths("tak* glaz**")).toEqual(["rim.md"]);
    expect(paths("NO*")).toEqual(["fired.md"]);
    expect(paths("*")).toEqual([]);
    expect(paths("**")).toEqual([]);
  });

  test("operators are still there for a caller that opts in", () => {
    expect(paths("pieces NOT porous", "fts5")).toEqual(["raw.md"]);
    expect(paths("glaze OR slip", "fts5")).toEqual(["finish.md", "rim.md"]);
    expect(paths("wedge AND knead", "fts5")).toEqual(["knead.md", "wedge.md"]);
  });
});

describe("searchPages on an underscore identifier", () => {
  const ranked = (query: string) =>
    searchPages(db, { query }).map((h) => h.path.replace("knowledge/", ""));

  beforeEach(() => {
    const note = (path: string, body: string) =>
      writePage(path, `---\ntype: note\n---\n\n${body}\n`);
    note(
      "metrics/stale-served.md",
      "# Cache metrics\n\n`stale_served` counts responses the cache answered after their entry expired.",
    );
    note(
      "metrics/stale-served-total.md",
      "# Totals\n\n`stale_served_total` is the counter behind the rate.",
    );
    note(
      "notes/replica-reads.md",
      "# Replica reads\n\nA lagging replica serves stale data. Those stale serves are tolerated for dashboards.",
    );
    note("notes/expiry.md", "# Expiry\n\nAn entry goes stale when its time to live runs out.");
    reindex();
  });

  test("an identifier matches only itself, not its stemmed words", () => {
    expect(ranked("stale_served")).toEqual(["metrics/stale-served.md"]);
    expect(ranked("Stale_Served")).toEqual(["metrics/stale-served.md"]);
  });

  test("an identifier no page holds falls back to the ordinary ranking", () => {
    expect(ranked("stale_serve")).toContain("metrics/stale-served.md");
    expect(ranked("stale_")).toContain("metrics/stale-served.md");
    expect(ranked("stale_serves")).toContain("notes/replica-reads.md");
  });

  test("an identifier written with a leading underscore is still found without it", () => {
    writePage(
      "code/signing.md",
      "---\ntype: note\n---\n\n# Signing\n\n`_private_helper` builds the signature.\n",
    );
    db.close();
    reindex();
    expect(ranked("private_helper")).toEqual(["code/signing.md"]);
  });

  test("a word inside an identifier still finds it", () => {
    expect(ranked("stale")).toContain("metrics/stale-served.md");
    expect(ranked("served stale")).toContain("metrics/stale-served.md");
  });

  test("a prefix and a phrase keep the identifier whole", () => {
    expect(ranked("stale_served*").toSorted()).toEqual([
      "metrics/stale-served-total.md",
      "metrics/stale-served.md",
    ]);
    expect(ranked("stale_ser*").toSorted()).toEqual([
      "metrics/stale-served-total.md",
      "metrics/stale-served.md",
    ]);
    expect(ranked('"stale_served counts"')).toEqual(["metrics/stale-served.md"]);
    expect(ranked("stale_served cache")).toEqual(["metrics/stale-served.md"]);
    expect(ranked("stale_*").toSorted()).toEqual([
      "metrics/stale-served-total.md",
      "metrics/stale-served.md",
    ]);
    expect(ranked("stale\\_served*").toSorted()).toEqual([
      "metrics/stale-served-total.md",
      "metrics/stale-served.md",
    ]);
  });

  test("underscores in odd places never reach the caller as a syntax error", () => {
    for (const query of ["_", "__", "_*", "stale_", '"_"', 'a_"b', "_stale_served_", "a_b*c_d*"]) {
      expect(() => searchPages(db, { query })).not.toThrow();
    }
  });

  test("an identifier is a run of letters and digits with an underscore in it", () => {
    expect(identifiersIn("a.stale_served, __init__ _ ___ 1_000 café_noir x")).toEqual([
      "stale_served",
      "__init__",
      "1_000",
      "café_noir",
    ]);
  });

  test("an identifier in a title, an alias or escaped in markdown is matched too", () => {
    writePage(
      "notes/titled.md",
      "---\ntype: note\ntitle: queue_depth\n---\n\nHow full the queue is.\n",
    );
    writePage(
      "notes/escaped.md",
      "---\ntype: note\n---\n\n# Late answers\n\n`lag\\_seconds` per call.\n",
    );
    writePage(
      "notes/aliased.md",
      '---\ntype: note\naliases: ["retry_budget"]\n---\n\n# Retries\n\nHow many retries a call may spend.\n',
    );
    db.close();
    reindex();
    expect(ranked("queue_depth")).toEqual(["notes/titled.md"]);
    expect(ranked("retry_budget")).toEqual(["notes/aliased.md"]);
    expect(ranked("lag_seconds")).toEqual(["notes/escaped.md"]);
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

  test("the term as the whole value of another frontmatter field is not an alias", () => {
    writePage("notes/field.md", "---\ntype: note\nsummary: climate forcing\n---\n\n# Field\n");
    reindex();
    const matches = findCanonical(db, "climate forcing", config);
    expect(matches.map((m) => m.path)).toEqual(["knowledge/concepts/forcing.md"]);
  });

  test("an alias JSON would escape still resolves", () => {
    // The old LIKE ran over JSON text, where this alias reads `the \"greenhouse\" effect`.
    writePage(
      "concepts/greenhouse.md",
      "---\ntype: concept\naliases: ['the \"greenhouse\" effect']\n---\n\n# Greenhouse\n",
    );
    reindex();
    const [match] = findCanonical(db, 'The "greenhouse" effect', config);
    expect(match?.path).toBe("knowledge/concepts/greenhouse.md");
  });

  test("a non-ASCII alias resolves case-insensitively, as the comparison always said", () => {
    writePage("concepts/emission.md", '---\ntype: concept\naliases: ["Émissions"]\n---\n\n# E\n');
    reindex();
    const [match] = findCanonical(db, "émissions", config);
    expect(match?.path).toBe("knowledge/concepts/emission.md");
  });

  test("a non-ASCII title resolves case-insensitively", () => {
    writePage("concepts/emission.md", "---\ntype: concept\n---\n\n# Émissions\n");
    reindex();
    const [match] = findCanonical(db, "émissions", config);
    expect(match?.path).toBe("knowledge/concepts/emission.md");
    expect(match?.matchedOn).toBe("title");
  });

  test("a decomposed É matches a composed one, in titles and aliases", () => {
    const composed = "Été";
    const decomposed = "Été";
    writePage("concepts/title.md", `---\ntype: concept\n---\n\n# ${decomposed}\n`);
    writePage(
      "concepts/alias.md",
      `---\ntype: concept\naliases: ["${decomposed} x"]\n---\n\n# A\n`,
    );
    reindex();
    expect(findCanonical(db, composed, config).map((m) => m.path)).toEqual([
      "knowledge/concepts/title.md",
    ]);
    expect(findCanonical(db, `${composed} x`, config).map((m) => m.path)).toEqual([
      "knowledge/concepts/alias.md",
    ]);
    expect(findCanonical(db, `${decomposed} x`, config)).toHaveLength(1);
  });

  test("aliases differing only in case yield one match", () => {
    writePage("concepts/rf.md", '---\ntype: concept\naliases: ["RF", "rf"]\n---\n\n# R\n');
    reindex();
    expect(findCanonical(db, "Rf", config)).toHaveLength(1);
  });

  test("a removed alias stops resolving after a rebuild", () => {
    writePage("concepts/forcing.md", "---\ntype: concept\n---\n\n# Radiative forcing\n");
    db.close();
    reindex();
    expect(findCanonical(db, "climate forcing", config)).toEqual([]);
  });
});

describe("an index built before a table existed", () => {
  function dropTable(table: string): void {
    writePage("a.md", '---\ntype: note\naliases: ["x"]\n---\n\n# A\n');
    buildIndex({ root, config, indexPath });
    const writable = new DatabaseSync(indexPath);
    writable.exec(`DROP TABLE ${table}`);
    writable.close();
    db = openIndex(indexPath, { readonly: true });
  }

  test("a table found once is not looked up again, and a missing one always is", () => {
    writePage("a.md", "---\ntype: note\n---\n\n# A\n");
    reindex();
    requireTable(db, "aliases");
    const writable = new DatabaseSync(indexPath);
    writable.exec("DROP TABLE aliases");
    expect(() => requireTable(db, "aliases")).not.toThrow();

    expect(() => requireTable(db, "later")).toThrow(StaleIndexError);
    writable.exec("CREATE TABLE later (x)");
    writable.close();
    expect(() => requireTable(db, "later")).not.toThrow();
  });

  test("findCanonical says to reindex when aliases is missing", () => {
    dropTable("aliases");
    expect(() => findCanonical(db, "x", config)).toThrow(StaleIndexError);
    expect(() => findCanonical(db, "x", config)).toThrow(
      "This index predates the aliases table; run `accreta reindex`.",
    );
  });

  test("lint says to reindex when aliases is missing", () => {
    dropTable("aliases");
    expect(() => lint(db, config)).toThrow(StaleIndexError);
  });

  test("citation readers say to reindex when citations is missing", async () => {
    dropTable("citations");
    expect(() => countPagesCiting(db, "s")).toThrow(
      "This index predates the citations table; run `accreta reindex`.",
    );
    await expect(lintCitations(db, new Map())).rejects.toThrow(StaleIndexError);
  });

  test("lint says to reindex when footnote_orphans is missing", () => {
    dropTable("footnote_orphans");
    expect(() => lint(db, config)).toThrow(StaleIndexError);
  });

  test("an identifier search says to reindex when pages_identifiers is missing", () => {
    writePage("b.md", "---\ntype: note\n---\n\n# B\n\n`stale_served` counts late answers.\n");
    dropTable("pages_identifiers");
    expect(() => searchPages(db, { query: "stale_served" })).toThrow(
      "This index predates the pages_identifiers table; run `accreta reindex`.",
    );
    expect(searchPages(db, { query: "stale served" }).map((h) => h.path)).toEqual([
      "knowledge/b.md",
    ]);

    db.close();
    reindex();
    expect(searchPages(db, { query: "stale_served" }).map((h) => h.path)).toEqual([
      "knowledge/b.md",
    ]);
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

  test("a missing target linked from a field and the body is one finding naming both (#274)", () => {
    writePage("a.md", "---\ntype: note\nrelated: [[missing]]\n---\n\n# A\n\nSee [[missing]].\n");
    reindex();
    const dangling = lint(db, config).findings.filter((f) => f.kind === "dangling-link");
    expect(dangling.map((f) => f.detail)).toEqual([
      "knowledge/missing.md (related, wikilink) is linked but no such page exists",
    ]);
  });

  test("an unresolvable target linked from a field and the body is one finding naming both", () => {
    writePage(
      "a.md",
      "---\ntype: note\nrelated: [[../../x]]\n---\n\n# A\n\nSee [[../../x]] and [[../../y]].\n",
    );
    reindex();
    const broken = lint(db, config).findings.filter((f) => f.kind === "broken-link");
    expect(broken.map((f) => f.detail)).toEqual([
      "[[../../x]] (related, wikilink) does not resolve: escapes-knowledge-base",
      "[[../../y]] (wikilink) does not resolve: escapes-knowledge-base",
    ]);
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

  test("an alias declared by two pages is one finding naming both (#263)", () => {
    writePage("a.md", '---\ntype: note\naliases: ["tenant override"]\n---\n\n# A\n');
    writePage("b.md", '---\ntype: note\naliases: ["Tenant Override "]\n---\n\n# B\n');
    reindex();
    expect(findCanonical(db, "tenant override", config)).toHaveLength(2);
    const shared = lint(db, config).findings.filter((f) => f.kind === "shared-alias");
    expect(shared).toHaveLength(1);
    expect(shared[0]?.path).toBe("knowledge/a.md");
    expect(shared[0]?.detail).toContain('"tenant override"');
    expect(shared[0]?.detail).toContain("knowledge/a.md (alias)");
    expect(shared[0]?.detail).toContain("knowledge/b.md (alias)");
  });

  test("a decomposed alias collides with a composed one, as canonical matches them", () => {
    writePage("a.md", '---\ntype: note\naliases: ["\u00c9t\u00e9"]\n---\n\n# A\n');
    writePage("b.md", '---\ntype: note\naliases: ["E\u0301te\u0301"]\n---\n\n# B\n');
    reindex();
    expect(lint(db, config).findings.filter((f) => f.kind === "shared-alias")).toHaveLength(1);
  });

  test("an alias equal to another page's title is shared, because canonical returns both", () => {
    writePage("a.md", '---\ntype: note\naliases: ["Forcing"]\n---\n\n# A\n');
    writePage("b.md", "---\ntype: note\n---\n\n# Forcing\n");
    reindex();
    expect(findCanonical(db, "forcing", config)).toHaveLength(2);
    const shared = lint(db, config).findings.filter((f) => f.kind === "shared-alias");
    expect(shared.map((f) => f.detail)).toEqual([
      '"forcing" names 2 pages, so canonical has no single answer: knowledge/a.md (alias), knowledge/b.md (title)',
    ]);
  });

  test("the finding points at the alias page, not an alphabetically earlier title-only page", () => {
    writePage("b.md", "---\ntype: note\n---\n\n# Forcing\n");
    writePage("z.md", '---\ntype: note\naliases: ["forcing"]\n---\n\n# Z\n');
    reindex();
    const shared = lint(db, config).findings.filter((f) => f.kind === "shared-alias");
    expect(shared.map((f) => f.path)).toEqual(["knowledge/z.md"]);
  });

  test("an alias equal to its own page's title, or repeated on one page, is not shared", () => {
    writePage("a.md", '---\ntype: note\naliases: ["Forcing", "forcing"]\n---\n\n# Forcing\n');
    reindex();
    expect(lint(db, config).findings.filter((f) => f.kind === "shared-alias")).toEqual([]);
  });

  test("two pages sharing only a title are left alone: no alias is involved", () => {
    writePage("a.md", "---\ntype: note\n---\n\n# Overview\n");
    writePage("b.md", "---\ntype: note\n---\n\n# Overview\n");
    reindex();
    expect(lint(db, config).findings.filter((f) => f.kind === "shared-alias")).toEqual([]);
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

// The body starts on line 9, after five frontmatter lines, a blank, the title and a blank.
const cited = (body: string) =>
  `---\ntype: note\ncanonical_source: "s:a.md#L1"\nlast_verified_revision: r1\n---\n\n# A\n\n${body}\n`;

describe("lint on footnote pairing", () => {
  const pairing = () =>
    lint(db, config).findings.filter(
      (f) => f.kind === "undefined-footnote" || f.kind === "unused-footnote",
    );

  test("a reference with no definition is reported with its id and line", () => {
    writePage("a.md", cited("A claim that looks cited.[^nowhere]"));
    reindex();
    const findings = pairing();
    expect(findings.map((f) => f.kind)).toEqual(["undefined-footnote"]);
    expect(findings[0]?.path).toBe("knowledge/a.md");
    expect(findings[0]?.detail).toContain("[^nowhere] (line 9)");
  });

  test("a definition nothing references is reported with its id and line", () => {
    writePage("a.md", cited("A claim.\n\n[^unused]: s @ r1 · a.md#L1-L2"));
    reindex();
    const findings = pairing();
    expect(findings.map((f) => f.kind)).toEqual(["unused-footnote"]);
    expect(findings[0]?.detail).toContain("[^unused] (line 11)");
  });

  test("a well-formed cited page has neither", () => {
    writePage(
      "a.md",
      cited("One.[^a] Two.[^b] One again.[^a]\n\n[^a]: s @ r1 · a.md#L1\n[^b]: See the history."),
    );
    reindex();
    expect(lint(db, config).findings).toEqual([]);
  });

  test("an undefined id referenced twice is one finding naming both lines", () => {
    writePage("a.md", cited("One.[^x]\n\nTwo.[^x]"));
    reindex();
    const findings = pairing();
    expect(findings).toHaveLength(1);
    expect(findings[0]?.detail).toContain("[^x] (lines 9, 11)");
  });

  test("footnotes inside fenced or inline code are not counted", () => {
    writePage(
      "a.md",
      cited(
        "Write `[^id]` to cite.\n\n```markdown\nA claim.[^fenced]\n\n[^example]: s @ r1 · a.md#L1\n```",
      ),
    );
    reindex();
    expect(pairing()).toEqual([]);
  });

  test("a definition referenced only from a referenced definition is used", () => {
    writePage(
      "a.md",
      cited("A claim.[^a]\n\n[^a]: s @ r1 · a.md#L1, read with [^b]\n[^b]: s @ r1 · a.md#L2"),
    );
    reindex();
    expect(pairing()).toEqual([]);
  });

  test("ids differing only in case pair up, and count as defined twice", async () => {
    writePage("a.md", cited("Claim.[^A]\n\n[^a]: s @ r1 · a.md#L1\n[^A]: s @ r1 · a.md#L2"));
    reindex();
    expect(pairing()).toEqual([]);
    const { findings } = await lintCitations(db, new Map());
    expect(findings.map((f) => f.kind)).toEqual(["duplicate-footnote"]);
    expect(findings[0]?.detail).toContain("[^A] is defined again at line 12");
  });

  test("definitions that reference only each other are both unused", () => {
    writePage(
      "a.md",
      cited("No claim cites these.\n\n[^a]: See [^b].\n[^b]: See [^a].\n[^c]: See [^gone]."),
    );
    reindex();
    expect(pairing().map((f) => `${f.kind} ${f.detail.split(" ")[0]}`)).toEqual([
      "undefined-footnote [^gone]",
      "unused-footnote [^a]",
      "unused-footnote [^b]",
      "unused-footnote [^c]",
    ]);
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

describe("countLines", () => {
  test("a final newline ends the last line rather than opening another", () => {
    expect(countLines("one\ntwo\n")).toBe(2);
    expect(countLines("one\ntwo")).toBe(2);
    expect(countLines("one\ntwo\nthree\n")).toBe(3);
  });

  test("an empty file has no lines, and a lone newline is one empty line", () => {
    expect(countLines("")).toBe(0);
    expect(countLines("\n")).toBe(1);
    expect(countLines("\n\n")).toBe(2);
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
  const lines = countLines(text);
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
    expect(report.uncheckedReasons).toEqual([
      { detail: "only the agent can reach this", citations: 1, paths: ["s:anything"] },
    ]);
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
    expect(report.uncheckedReasons).toEqual([
      { detail: "connection refused", citations: 1, paths: ["s:doc.md"] },
    ]);
  });

  test("unchecked citations sharing a reason are one group listing their paths", async () => {
    const dirty: SourceAdapter = {
      ...source("s", {}),
      locate: async () => ({ verdict: "unknown", detail: "uncommitted changes" }),
    };
    for (const name of ["a", "b", "c"]) {
      writePage(
        `${name}.md`,
        `---\ntype: note\ncanonical_source: "s:${name === "c" ? "a" : name}.md#L1"\n---\n\n# ${name}\n`,
      );
    }
    reindex();
    const report = await lintCitations(db, sources(dirty));
    expect(report.uncheckedReasons).toEqual([
      { detail: "uncommitted changes", citations: 3, paths: ["s:a.md", "s:b.md"] },
    ]);
  });
});

const page = (footnotes: string[]) =>
  `---\ntype: note\n---\n\n# A\n\nA claim.[^a]\n\n${footnotes.join("\n")}\n`;

describe("lintCitations on footnotes", () => {
  const tenLines = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join("\n");
  const withHistory = (revisions: string[]): SourceAdapter => ({
    ...source("s", { "doc.md": tenLines }),
    knowsRevision: async (revision) => revisions.includes(revision),
  });

  test("one correct and three broken footnotes give exactly three findings", async () => {
    writePage(
      "a.md",
      "---\ntype: note\n---\n\n# A\n\nOne.[^ok] Two.[^path] Three.[^lines] Four.[^rev]\n\n" +
        "[^ok]: s @ r1 · doc.md#L2-L4\n" +
        "[^path]: s @ r1 · invented.md#L1\n" +
        "[^lines]: s @ r1 · doc.md#L8-L40\n" +
        "[^rev]: s @ f00dfeed · doc.md#L1\n",
    );
    reindex();
    const report = await lintCitations(db, sources(withHistory(["r1"])));
    expect(report.findings.map((f) => f.kind)).toEqual([
      "citation-path-missing",
      "citation-locator-missing",
      "citation-revision-unknown",
    ]);
    expect(report.findings[0]?.detail).toContain("[^path] (line 10)");
    expect(report.citationsChecked).toBe(4);
  });

  test("a footnote id defined twice is reported, not silently dropped", async () => {
    writePage("a.md", page(["[^a]: s @ r1 · doc.md#L1", "[^a]: s @ r1 · doc.md#L2"]));
    reindex();
    const { findings } = await lintCitations(db, sources(withHistory(["r1"])));
    expect(findings.map((f) => f.kind)).toEqual(["duplicate-footnote"]);
  });

  test("a footnote naming no revision is unpinned", async () => {
    writePage("a.md", page(["[^a]: s @ unknown · doc.md#L1"]));
    reindex();
    const { findings } = await lintCitations(db, sources(withHistory(["r1"])));
    expect(findings.map((f) => f.kind)).toEqual(["citation-unpinned"]);
  });

  test("a source that keeps no history is not asked about revisions", async () => {
    writePage("a.md", page(["[^a]: s @ anything · doc.md#L1"]));
    reindex();
    const { findings } = await lintCitations(db, sources(source("s", { "doc.md": tenLines })));
    expect(findings).toEqual([]);
  });

  test("a mangled citation is reported, a prose footnote is not", async () => {
    writePage("a.md", page(["[^a]: s @ r1 · ", "[^note]: See the design notes for the history."]));
    reindex();
    const report = await lintCitations(db, sources(withHistory(["r1"])));
    expect(report.findings.map((f) => f.kind)).toEqual(["unparseable-citation"]);
  });

  test("a format that cannot be read back is one finding against the config", () => {
    writePage("a.md", page(["[^a]: s @ r1 · doc.md#L1"]));
    buildIndex({ root, config: { ...config, provenanceFormat: "{source}{path}" }, indexPath });
    db = openIndex(indexPath, { readonly: true });
    const report = lint(db, { ...config, provenanceFormat: "{source}{path}" });
    const format = report.findings.filter((f) => f.kind === "unreadable-provenance-format");
    expect(format).toHaveLength(1);
    expect(format[0]?.path).toBe("accreta.config.yaml");
  });

  test("a format that names no revision is one finding against the config", () => {
    writePage("a.md", page(["[^a]: s · doc.md#L1"]));
    const noRev = { ...config, provenanceFormat: "{source} · {path}#{locator}" };
    buildIndex({ root, config: noRev, indexPath });
    db = openIndex(indexPath, { readonly: true });
    const unpinned = lint(db, noRev).findings.filter(
      (f) => f.kind === "unpinned-provenance-format",
    );
    expect(unpinned).toHaveLength(1);
    expect(unpinned[0]?.path).toBe("accreta.config.yaml");
    // Adding {rev} alone pins no footnote already written; each has to be re-cited.
    expect(unpinned[0]?.detail).toContain("accreta cite");
    expect(unpinned[0]?.detail).toContain("can read as prose");
  });

  test("footnotes written before a format change stay findings (#249)", async () => {
    for (const name of ["a", "b", "c"]) {
      writePage(`${name}.md`, page(["[^a]: s · doc.md#L1", "[^b]: s · doc.md#L2"]));
    }
    reindex();
    const report = await lintCitations(db, sources(withHistory(["r1"])));
    expect(report.findings.map((f) => f.kind)).toEqual(Array(6).fill("unparseable-citation"));
    expect(report.findings[0]?.path).toBe("knowledge/a.md");
    expect(report.findings[0]?.detail).toContain("[^a]");
    expect(report.findings[0]?.detail).toContain("accreta cite");
  });

  test("prose footnotes stay prose after a format change", async () => {
    writePage(
      "a.md",
      page([
        "[^a]: See the appendix.",
        "[^b]: Background at https://example.com/guide#setup.",
        "[^c]: Compare [[forcing#history]].",
      ]),
    );
    reindex();
    const report = await lintCitations(db, sources(withHistory(["r1"])));
    expect(report.findings).toEqual([]);
    expect(report.pagesChecked).toBe(0);
  });

  test("the default format names a revision", () => {
    writePage("a.md", page(["[^a]: s @ r1 · doc.md#L1"]));
    reindex();
    const kinds = lint(db, config).findings.map((f) => f.kind);
    expect(kinds).not.toContain("unpinned-provenance-format");
  });
});

const twoSources = (a: SourceAdapter, b: SourceAdapter) =>
  new Map([
    [a.id, a],
    [b.id, b],
  ]);

const verified = (sourceId: string, revision: string) =>
  `---\ntype: note\nsource: ${sourceId}\nlast_verified_revision: ${revision}\n---\n\n# A\n`;

describe("lintCitations on last_verified_revision", () => {
  const withHistory = (id: string, revisions: string[]): SourceAdapter => ({
    ...source(id, {}),
    knowsRevision: async (revision) => revisions.includes(revision),
  });

  test("a revision only another source has is reported (#260)", async () => {
    writePage("a.md", verified("a", "rev-of-b"));
    reindex();
    const { findings } = await lintCitations(
      db,
      twoSources(withHistory("a", ["rev-of-a"]), withHistory("b", ["rev-of-b"])),
    );
    expect(findings).toEqual([
      {
        kind: "verified-revision-unknown",
        path: "knowledge/a.md",
        detail:
          'source "a" cannot place last_verified_revision rev-of-b (history rewritten, shallow clone, or a different repository); re-verify against "a" before recording a revision',
      },
    ]);
  });

  test("a revision the page's own source has is clean", async () => {
    writePage("a.md", verified("a", "rev-of-a"));
    reindex();
    const { findings } = await lintCitations(
      db,
      twoSources(withHistory("a", ["rev-of-a"]), withHistory("b", ["rev-of-b"])),
    );
    expect(findings).toEqual([]);
  });

  test("a source that keeps no history, or is not loaded, is not asked", async () => {
    writePage("a.md", verified("a", "anything"));
    writePage("b.md", verified("absent", "anything"));
    reindex();
    const { findings } = await lintCitations(
      db,
      twoSources(source("a", {}), withHistory("b", ["rev-of-b"])),
    );
    expect(findings).toEqual([]);
  });
});
