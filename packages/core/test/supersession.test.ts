import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, parseConfig, type AccretaConfig } from "../src/config.ts";
import { buildIndex } from "../src/index-db/build.ts";
import { openIndex, type Database } from "../src/index-db/db.ts";
import { lint, lintKnowledgeBase } from "../src/query/lint.ts";

let root = "";
let indexPath = "";
let db: Database | undefined;

const config: AccretaConfig = { ...DEFAULT_CONFIG, pageTypes: ["note"] };

const SUPERSESSION_KINDS = new Set(["inconsistent-supersession", "unreadable-supersession-fields"]);

function writePage(name: string, fields: Record<string, string> = {}): void {
  const extra = Object.entries(fields)
    .map(([key, value]) => `${key}: ${value}\n`)
    .join("");
  const full = join(root, "knowledge", `${name}.md`);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(
    full,
    `---\ntype: note\ncanonical_source: "s:${name}.txt#L1"\nlast_verified_revision: abc\n${extra}---\n\n# ${name}\n`,
  );
}

function reindex(with_: AccretaConfig = config): Database {
  db?.close();
  buildIndex({ root, config: with_, indexPath });
  db = openIndex(indexPath, { readonly: true });
  return db;
}

function supersessionFindings(with_: AccretaConfig = config) {
  return lint(reindex(with_), with_).findings.filter((f) => SUPERSESSION_KINDS.has(f.kind));
}

const padded = (i: number) => `p${String(i).padStart(5, "0")}`;

// The advice is everything after the first sentence; paths contain no ". ".
const advice = (detail: string) => detail.slice(detail.indexOf(". ") + 2);

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "accreta-supersession-"));
  indexPath = join(root, ".index", "accreta.sqlite");
  db = undefined;
});

afterEach(() => {
  db?.close();
  rmSync(root, { recursive: true, force: true });
});

describe("inconsistent-supersession", () => {
  // The knowledge base from issue #81: each page claims to replace the other, and lint was clean.
  test("two pages that each supersede the other are one finding", () => {
    writePage("a", { supersedes: "[[b]]", superseded_by: "[[b]]" });
    writePage("b", { supersedes: "[[a]]", superseded_by: "[[a]]" });

    const findings = supersessionFindings();

    expect(findings).toHaveLength(1);
    expect(findings[0]!.path).toBe("knowledge/a.md");
    expect(findings[0]!.detail).toContain("knowledge/a.md");
    expect(findings[0]!.detail).toContain("knowledge/b.md");
  });

  test("a mutual pair declared on one side only is still one finding, with no reciprocal asked for", () => {
    writePage("a", { supersedes: "[[b]]" });
    writePage("b", { supersedes: "[[a]]" });
    expect(supersessionFindings()).toHaveLength(1);
  });

  test("a mutual pair written only as superseded_by is the same contradiction", () => {
    writePage("a", { superseded_by: "[[b]]" });
    writePage("b", { superseded_by: "[[a]]" });
    const findings = supersessionFindings();
    expect(findings.map((f) => f.path)).toEqual(["knowledge/a.md"]);
    expect(findings[0]!.detail).toStartWith(
      "2 pages claim to supersede one another in a loop: knowledge/a.md → knowledge/b.md → knowledge/a.md",
    );
  });

  test("a page that supersedes itself is reported", () => {
    writePage("a", { supersedes: "[[a]]", superseded_by: "[[a]]" });
    const findings = supersessionFindings();
    expect(findings).toHaveLength(1);
    expect(findings[0]!.detail).toStartWith("knowledge/a.md claims to supersede itself. ");
  });

  test("a self-edge inside a larger loop is named as well", () => {
    writePage("a", { supersedes: "[[a]], [[b]]" });
    writePage("b", { supersedes: "[[a]]" });
    const [finding, ...rest] = supersessionFindings();
    expect(rest).toEqual([]);
    expect(finding!.detail).toStartWith(
      "2 pages claim to supersede one another in a loop: knowledge/a.md → knowledge/b.md → knowledge/a.md (each supersedes the next), and knowledge/a.md claims to supersede itself. ",
    );
  });

  test("a loop through three pages is one finding, with advice that does not invite relabelling", () => {
    writePage("a", { supersedes: "[[b]]", superseded_by: "[[c]]" });
    writePage("b", { supersedes: "[[c]]", superseded_by: "[[a]]" });
    writePage("c", { supersedes: "[[a]]", superseded_by: "[[b]]" });

    const findings = supersessionFindings();

    expect(findings).toHaveLength(1);
    expect(findings[0]!.path).toBe("knowledge/a.md");
    expect(findings[0]!.detail).toContain(
      "knowledge/a.md → knowledge/b.md → knowledge/c.md → knowledge/a.md",
    );
    expect(advice(findings[0]!.detail)).toBe(
      "Between pages that each stand for one document, supersession cannot loop. A loop usually means one page stands for two revisions (for example a reinstated version), so split that page. If this knowledge base uses these fields for something that can loop, set supersession_fields: false",
    );
  });

  // The likeliest real loop is a revert, a 2-cycle, so it must not get different advice from a longer one.
  test("a two-page and a three-page loop carry the same advice", () => {
    writePage("a", { supersedes: "[[b]]" });
    writePage("b", { supersedes: "[[a]]" });
    writePage("x", { supersedes: "[[y]]" });
    writePage("y", { supersedes: "[[z]]" });
    writePage("z", { supersedes: "[[x]]" });
    const [pair, triple, ...rest] = supersessionFindings();
    expect(rest).toEqual([]);
    expect(pair!.detail).toStartWith("2 pages");
    expect(triple!.detail).toStartWith("3 pages");
    expect(advice(pair!.detail)).toBe(advice(triple!.detail));
  });

  test("a loop names every page in it, not only the shortest way round", () => {
    // a→b→a and a→c→a share a, so all three pages are one knot.
    writePage("a", { supersedes: "[[b]], [[c]]" });
    writePage("b", { supersedes: "[[a]]" });
    writePage("c", { supersedes: "[[a]]" });
    const [finding, ...rest] = supersessionFindings();
    expect(rest).toEqual([]);
    for (const page of ["a", "b", "c"]) expect(finding!.detail).toContain(`knowledge/${page}.md`);
  });

  // Naming every page made one finding 460 KB and lint quadratic (1,770 ms); paging caps count, not size.
  test("a loop through 20,000 pages lints in linear time and its detail stays small", () => {
    const n = 20_000;
    db = openIndex(indexPath);
    const page = db.query(
      `INSERT INTO pages (path, type, title, canonical_source, last_verified_revision, frontmatter_json, body, mtime)
       VALUES (?, 'note', ?, 's:x#L1', 'abc', '{}', '', 0)`,
    );
    const link = db.query(
      `INSERT INTO links (src_path, dst_path, kind) VALUES (?, ?, 'supersedes')`,
    );
    const path = (i: number) => `knowledge/${padded(i)}.md`;
    db.transaction(() => {
      for (let i = 0; i < n; i++) {
        page.run(path(i), padded(i));
        link.run(path(i), path((i + 1) % n));
      }
    })();

    const t0 = performance.now();
    const findings = lint(db!, config).findings.filter(
      (f) => f.kind === "inconsistent-supersession",
    );
    const ms = performance.now() - t0;

    expect(findings).toHaveLength(1);
    expect(findings[0]!.detail).toStartWith("20000 pages claim to supersede one another in a loop");
    expect(findings[0]!.detail).toContain("… 19980 more …");
    expect(findings[0]!.detail.length).toBeLessThan(4096);
    expect(ms).toBeLessThan(1_000);
  });

  test("a chain that runs one way, recorded on both sides, is clean", () => {
    writePage("v1", { superseded_by: "[[v2]]" });
    writePage("v2", { supersedes: "[[v1]]", superseded_by: "[[v3]]" });
    writePage("v3", { supersedes: "[[v2]]" });
    expect(supersessionFindings()).toEqual([]);
  });

  test("a supersedes edge whose target lacks the reciprocal is filed against the page claiming it", () => {
    writePage("a-old", {});
    writePage("new", { supersedes: "[[a-old]]" });

    const findings = supersessionFindings();

    expect(findings).toHaveLength(1);
    expect(findings[0]!.path).toBe("knowledge/new.md");
    expect(findings[0]!.detail).toBe(
      "knowledge/new.md says supersedes: knowledge/a-old.md, but knowledge/a-old.md does not record it. Find the line in knowledge/new.md's source that says so; if it exists, record superseded_by on knowledge/a-old.md citing that line. If no source says it, remove the claim",
    );
  });

  test("the mirror, a superseded_by without the reciprocal supersedes, asks for the successor's evidence", () => {
    writePage("old", { superseded_by: "[[new]]" });
    writePage("new", {});

    const findings = supersessionFindings();

    expect(findings).toHaveLength(1);
    expect(findings[0]!.path).toBe("knowledge/old.md");
    expect(findings[0]!.detail).toBe(
      "knowledge/old.md says superseded_by: knowledge/new.md, but knowledge/new.md does not record it. The evidence must come from knowledge/new.md's source or a registry, never from knowledge/old.md's own source; if such a line exists, record supersedes on knowledge/new.md citing it. If no source says it, remove the claim",
    );
  });

  test("a page whose frontmatter did not load is not said to lack the reciprocal", () => {
    writePage("new", { supersedes: "[[old]]" });
    writeFileSync(
      join(root, "knowledge", "old.md"),
      "---\ntype: note\nsuperseded_by: [[new]]\nbroken: [unclosed\n---\n\n# old\n",
    );

    const kinds = lint(reindex(), config).findings.map((f) => f.kind);

    expect(kinds).toContain("unparseable-frontmatter");
    expect(kinds).not.toContain("inconsistent-supersession");
  });

  test("an edge to a page that does not exist is left to dangling-link", () => {
    writePage("new", { supersedes: "[[gone]]" });
    expect(supersessionFindings()).toEqual([]);
    expect(lint(db!, config).findings.map((f) => f.kind)).toContain("dangling-link");
  });
});

describe("supersession_fields", () => {
  test("names the pair, so a knowledge base with its own words is checked in them", () => {
    const own: AccretaConfig = {
      ...config,
      linkFields: ["replaces", "replaced_by", "supersedes"],
      supersessionFields: { supersedes: "replaces", supersededBy: "replaced_by" },
    };
    writePage("old", {});
    writePage("new", { replaces: "[[old]]" });
    writePage("other", { supersedes: "[[old]]" });

    const findings = supersessionFindings(own);

    expect(findings).toHaveLength(1);
    expect(findings[0]!.detail).toContain("knowledge/new.md says replaces: knowledge/old.md");
    expect(findings[0]!.detail).toContain("record replaced_by on knowledge/old.md");
  });

  test("unset, with the default pair not in link_fields, the check does not apply and lint is clean", () => {
    const plain: AccretaConfig = { ...config, linkFields: ["related"] };
    writePage("a", { supersedes: "[[b]]" });
    writePage("b", { supersedes: "[[a]]" });

    expect(supersessionFindings(plain)).toEqual([]);
    expect(lint(db!, plain).findings).toEqual([]);
  });

  test("unset, with only one default field in link_fields, the check does not apply either", () => {
    writePage("a", { supersedes: "[[b]]" });
    writePage("b", {});
    expect(supersessionFindings({ ...config, linkFields: ["supersedes"] })).toEqual([]);
  });

  test("a pair naming a field that is not a link field is a config finding of its own kind", () => {
    const wrong: AccretaConfig = {
      ...config,
      supersessionFields: { supersedes: "supersedes", supersededBy: "replaced_by" },
    };
    writePage("a", {});

    const findings = supersessionFindings(wrong);

    expect(findings).toHaveLength(1);
    expect(findings[0]!.kind).toBe("unreadable-supersession-fields");
    expect(findings[0]!.path).toBe("accreta.config.yaml");
    expect(findings[0]!.detail).toStartWith("supersession_fields names replaced_by,");
  });

  test("each malformed value is one config finding, and the default pair is not checked instead", () => {
    writePage("a", { supersedes: "[[b]]" });
    writePage("b", { supersedes: "[[a]]" });
    for (const value of [
      "no",
      "off",
      "[supersedes, superseded_by]",
      "{ supersedes: supersedes }",
      "{ supersedes: supersedes, superseded_by: supersedes }",
      "",
    ]) {
      const malformed = { ...parseConfig(`supersession_fields: ${value}`), pageTypes: ["note"] };
      expect(supersessionFindings(malformed)).toEqual([
        {
          kind: "unreadable-supersession-fields",
          path: "accreta.config.yaml",
          detail:
            "supersession_fields is set but is not two distinct link-field names, so supersession was not checked",
        },
      ]);
    }
  });

  test("false turns the check off, and lint says nothing", () => {
    writePage("a", { supersedes: "[[b]]" });
    writePage("b", { supersedes: "[[a]]" });
    expect(supersessionFindings({ ...config, supersessionFields: null })).toEqual([]);
    expect(
      supersessionFindings({ ...config, linkFields: ["related"], supersessionFields: null }),
    ).toEqual([]);
  });

  test("the kind filter keeps graph findings apart from config ones", async () => {
    writePage("a", { supersedes: "[[b]]" });
    writePage("b", { supersedes: "[[a]]" });
    reindex();
    const graph = await lintKnowledgeBase(db!, config, new Map(), {
      kinds: ["inconsistent-supersession"],
    });
    expect(graph.findings.map((f) => f.path)).toEqual(["knowledge/a.md"]);

    const malformed: AccretaConfig = { ...config, supersessionFields: { invalid: "off" } };
    const noGraph = await lintKnowledgeBase(db!, malformed, new Map(), {
      kinds: ["inconsistent-supersession"],
    });
    expect(noGraph.findings).toEqual([]);
    const onlyConfig = await lintKnowledgeBase(db!, malformed, new Map(), {
      kinds: ["unreadable-supersession-fields"],
    });
    expect(onlyConfig.findings.map((f) => f.path)).toEqual(["accreta.config.yaml"]);
  });
});
