import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, type AccretaConfig } from "../src/config.ts";
import { buildIndex } from "../src/index-db/build.ts";
import { openIndex, type Database } from "../src/index-db/db.ts";
import { lint, lintKnowledgeBase } from "../src/query/lint.ts";

let root = "";
let indexPath = "";
let db: Database | undefined;

const config: AccretaConfig = { ...DEFAULT_CONFIG, pageTypes: ["note"] };

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

function supersessionFindings(with_: AccretaConfig = config) {
  db?.close();
  buildIndex({ root, config: with_, indexPath });
  db = openIndex(indexPath, { readonly: true });
  return lint(db, with_).findings.filter((f) => f.kind === "inconsistent-supersession");
}

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
    expect(findings[0]!.detail).toContain("each claim to supersede the other");
  });

  test("a page that supersedes itself is reported", () => {
    writePage("a", { supersedes: "[[a]]", superseded_by: "[[a]]" });
    const findings = supersessionFindings();
    expect(findings).toHaveLength(1);
    expect(findings[0]!.detail).toContain("supersede itself");
  });

  test("a loop through three pages is one finding, worded as claims to check", () => {
    writePage("a", { supersedes: "[[b]]", superseded_by: "[[c]]" });
    writePage("b", { supersedes: "[[c]]", superseded_by: "[[a]]" });
    writePage("c", { supersedes: "[[a]]", superseded_by: "[[b]]" });

    const findings = supersessionFindings();

    expect(findings).toHaveLength(1);
    expect(findings[0]!.path).toBe("knowledge/a.md");
    expect(findings[0]!.detail).toContain(
      "knowledge/a.md → knowledge/b.md → knowledge/c.md → knowledge/a.md",
    );
    expect(findings[0]!.detail).toContain("check each claim against its source");
    expect(findings[0]!.detail).toContain("revision history that really loops");
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

  test("a chain that runs one way, recorded on both sides, is clean", () => {
    writePage("v1", { superseded_by: "[[v2]]" });
    writePage("v2", { supersedes: "[[v1]]", superseded_by: "[[v3]]" });
    writePage("v3", { supersedes: "[[v2]]" });
    expect(supersessionFindings()).toEqual([]);
  });

  test("a supersedes edge whose target lacks the reciprocal is reported once, naming both", () => {
    writePage("old", {});
    writePage("new", { supersedes: "[[old]]" });

    const findings = supersessionFindings();

    expect(findings).toHaveLength(1);
    expect(findings[0]!.path).toBe("knowledge/new.md");
    expect(findings[0]!.detail).toBe(
      "knowledge/new.md says supersedes: knowledge/old.md, but knowledge/old.md has no superseded_by naming knowledge/new.md, so a reader landing on knowledge/old.md is not told it was replaced; add it, or drop the claim if no source makes it",
    );
  });

  test("the mirror, a superseded_by without the reciprocal supersedes, is reported the same way", () => {
    writePage("old", { superseded_by: "[[new]]" });
    writePage("new", {});

    const findings = supersessionFindings();

    expect(findings).toHaveLength(1);
    expect(findings[0]!.path).toBe("knowledge/new.md");
    expect(findings[0]!.detail).toContain("knowledge/old.md says superseded_by: knowledge/new.md");
    expect(findings[0]!.detail).toContain(
      "knowledge/new.md has no supersedes naming knowledge/old.md",
    );
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
    expect(findings[0]!.detail).toContain("no replaced_by");
  });

  test("unset, with the default pair not in link_fields, lint says once that it did not check", () => {
    const plain: AccretaConfig = { ...config, linkFields: ["related"] };
    writePage("a", { supersedes: "[[b]]" });
    writePage("b", { supersedes: "[[a]]" });

    const findings = supersessionFindings(plain);

    expect(findings).toEqual([
      {
        kind: "inconsistent-supersession",
        path: "accreta.config.yaml",
        detail:
          "supersession_fields is not set, and its default pair names supersedes and superseded_by, which link_fields does not list, so supersession is not checked; name the pair in supersession_fields, or set it to false",
      },
    ]);
  });

  test("a pair naming a field that is not a link field is a config finding", () => {
    const wrong: AccretaConfig = {
      ...config,
      supersessionFields: { supersedes: "supersedes", supersededBy: "replaced_by" },
    };
    writePage("a", {});

    const findings = supersessionFindings(wrong);

    expect(findings).toHaveLength(1);
    expect(findings[0]!.path).toBe("accreta.config.yaml");
    expect(findings[0]!.detail).toStartWith("supersession_fields names replaced_by,");
  });

  test("false turns the check off, and lint says nothing", () => {
    writePage("a", { supersedes: "[[b]]" });
    writePage("b", { supersedes: "[[a]]" });
    expect(supersessionFindings({ ...config, supersessionFields: null })).toEqual([]);
    expect(
      supersessionFindings({ ...config, linkFields: ["related"], supersessionFields: null }),
    ).toEqual([]);
  });

  test("the kind filter reaches it", async () => {
    writePage("a", { supersedes: "[[b]]" });
    writePage("b", { supersedes: "[[a]]" });
    supersessionFindings();
    const report = await lintKnowledgeBase(db!, config, new Map(), {
      kinds: ["inconsistent-supersession"],
    });
    expect(report.findings.map((f) => f.path)).toEqual(["knowledge/a.md"]);
  });
});
