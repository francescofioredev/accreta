import { describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG, type AccretaConfig } from "../src/config.ts";
import { extractLinks, resolveWikilink } from "../src/links.ts";
import { parsePage } from "../src/page.ts";

const config: AccretaConfig = {
  ...DEFAULT_CONFIG,
  knowledgeBase: "knowledge",
  linkFields: ["related", "discussed_in", "supersedes"],
};

describe("extractLinks", () => {
  test("typed links come from the configured link fields", () => {
    const { frontmatter, body } = parsePage(
      "---\nrelated: [[concepts/a]]\ndiscussed_in: [[synthesis/b]]\n---\n\n# X\n",
      "fb",
    );
    expect(extractLinks(frontmatter, body, config)).toEqual([
      { target: "concepts/a", kind: "related" },
      { target: "synthesis/b", kind: "discussed_in" },
    ]);
  });

  test("a frontmatter field that is not configured as a link field is ignored", () => {
    const { frontmatter, body } = parsePage("---\nmentions: [[concepts/a]]\n---\n\n# X\n", "fb");
    expect(extractLinks(frontmatter, body, config)).toEqual([]);
  });

  test("the same field is a link or not depending on configuration alone", () => {
    const { frontmatter, body } = parsePage("---\ncites: [[papers/a]]\n---\n\n# X\n", "fb");
    expect(extractLinks(frontmatter, body, config)).toEqual([]);
    const citing = { ...config, linkFields: ["cites"] };
    expect(extractLinks(frontmatter, body, citing)).toEqual([
      { target: "papers/a", kind: "cites" },
    ]);
  });

  test("inline body wikilinks are untyped", () => {
    const { frontmatter, body } = parsePage("# X\n\nSee [[concepts/a]] for detail.\n", "fb");
    expect(extractLinks(frontmatter, body, config)).toEqual([
      { target: "concepts/a", kind: "wikilink" },
    ]);
  });

  test("anchors and display labels are stripped from the target", () => {
    const { frontmatter, body } = parsePage(
      "# X\n\n[[concepts/a#section]] and [[concepts/b|nice label]].\n",
      "fb",
    );
    expect(extractLinks(frontmatter, body, config)).toEqual([
      { target: "concepts/a", kind: "wikilink" },
      { target: "concepts/b", kind: "wikilink" },
    ]);
  });

  test("a page with no links yields none", () => {
    const { frontmatter, body } = parsePage("---\ntype: note\n---\n\n# X\n\nProse.\n", "fb");
    expect(extractLinks(frontmatter, body, config)).toEqual([]);
  });
});

describe("resolveWikilink", () => {
  test("a bare target is placed inside the knowledge base", () => {
    expect(resolveWikilink("concepts/a", config)).toBe("knowledge/concepts/a.md");
  });

  test("an explicit .md suffix is not doubled", () => {
    expect(resolveWikilink("concepts/a.md", config)).toBe("knowledge/concepts/a.md");
  });

  test("a target already rooted at the knowledge base is left alone", () => {
    expect(resolveWikilink("knowledge/concepts/a", config)).toBe("knowledge/concepts/a.md");
  });

  test("the knowledge-base directory comes from configuration", () => {
    const wiki = { ...config, knowledgeBase: "wiki" };
    expect(resolveWikilink("concepts/a", wiki)).toBe("wiki/concepts/a.md");
  });

  test("surrounding whitespace is ignored", () => {
    expect(resolveWikilink("  concepts/a  ", config)).toBe("knowledge/concepts/a.md");
  });
});
