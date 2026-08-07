import { describe, expect, test } from "bun:test";
import { parsePage } from "../src/page.ts";

describe("parsePage", () => {
  test("a page with no frontmatter keeps its whole body", () => {
    const page = parsePage("# Just a heading\n\nSome prose.\n", "fallback");
    expect(page.frontmatter).toEqual({});
    expect(page.body).toBe("# Just a heading\n\nSome prose.\n");
    expect(page.title).toBe("Just a heading");
  });

  test("frontmatter is separated from the body", () => {
    const page = parsePage("---\ntype: concept\n---\n\n# Radiative forcing\n\nText.\n", "fb");
    expect(page.frontmatter.type).toBe("concept");
    expect(page.body).toBe("# Radiative forcing\n\nText.\n");
  });

  test("a frontmatter title wins over the first heading", () => {
    const page = parsePage('---\ntitle: "Preferred"\n---\n\n# Ignored\n', "fb");
    expect(page.title).toBe("Preferred");
  });

  test("the first heading is used when frontmatter names no title", () => {
    const page = parsePage("---\ntype: note\n---\n\n# From heading\n", "fb");
    expect(page.title).toBe("From heading");
  });

  test("the fallback title is used when there is neither", () => {
    const page = parsePage("---\ntype: note\n---\n\nNo heading here.\n", "concepts/forcing");
    expect(page.title).toBe("concepts/forcing");
  });

  test("malformed YAML yields an empty frontmatter, and the page still parses", () => {
    const page = parsePage("---\ntype: [unclosed\n---\n\n# Still a page\n", "fb");
    expect(page.frontmatter).toEqual({});
    expect(page.title).toBe("Still a page");
    expect(page.body).toContain("# Still a page");
  });

  test("aliases survive as a list", () => {
    const page = parsePage(
      '---\naliases: ["radiative forcing", "climate forcing"]\n---\n\n# X\n',
      "fb",
    );
    expect(page.frontmatter.aliases).toEqual(["radiative forcing", "climate forcing"]);
  });

  test("a page that is only frontmatter parses, with an empty body", () => {
    const page = parsePage("---\ntype: note\n---\n", "fb");
    expect(page.frontmatter.type).toBe("note");
    expect(page.body.trim()).toBe("");
    expect(page.title).toBe("fb");
  });

  test("CRLF line endings parse the same as LF", () => {
    const page = parsePage("---\r\ntype: note\r\n---\r\n\r\n# Windows\r\n", "fb");
    expect(page.frontmatter.type).toBe("note");
    expect(page.title).toBe("Windows");
  });
});

describe("parsePage — wikilinks inside frontmatter", () => {
  test("a bare wikilink value is not valid YAML but still parses", () => {
    const page = parsePage("---\ndiscussed_in: [[synthesis/energy-balance]]\n---\n\n# X\n", "fb");
    expect(page.frontmatter.discussed_in).toEqual(["[[synthesis/energy-balance]]"]);
  });

  test("comma-separated wikilinks become a list", () => {
    const page = parsePage("---\nrelated: [[concepts/a]], [[concepts/b]]\n---\n\n# X\n", "fb");
    expect(page.frontmatter.related).toEqual(["[[concepts/a]]", "[[concepts/b]]"]);
  });

  test("wikilinks inside an explicit flow sequence parse", () => {
    const page = parsePage("---\nrelated: [[[concepts/a]], [[concepts/b]]]\n---\n\n# X\n", "fb");
    expect(page.frontmatter.related).toEqual(["[[concepts/a]]", "[[concepts/b]]"]);
  });

  test("wikilinks in a block sequence parse", () => {
    const page = parsePage(
      "---\nrelated:\n  - [[concepts/a]]\n  - [[concepts/b]]\n---\n\n# X\n",
      "fb",
    );
    expect(page.frontmatter.related).toEqual(["[[concepts/a]]", "[[concepts/b]]"]);
  });

  test("a line with no wikilink is left exactly as YAML would read it", () => {
    const page = parsePage("---\ncount: 3\nflag: true\nname: plain\n---\n\n# X\n", "fb");
    expect(page.frontmatter.count).toBe(3);
    expect(page.frontmatter.flag).toBe(true);
    expect(page.frontmatter.name).toBe("plain");
  });
});
