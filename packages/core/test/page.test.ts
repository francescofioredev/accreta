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
    // The page is still indexed — refusing it would hide the one page most
    // likely to need fixing — but why it is empty is no longer thrown away.
    expect(page.frontmatterError).toBeTruthy();
  });

  test("a page that simply declares nothing is not an error", () => {
    expect(parsePage("# A page\n", "fb").frontmatterError).toBeUndefined();
    expect(parsePage("---\ntype: note\n---\n\n# A\n", "fb").frontmatterError).toBeUndefined();
  });

  test("a frontmatter that parses to a list rather than fields is recorded", () => {
    // The quieter failure: nothing throws, and the page just arrives with no
    // fields at all.
    const page = parsePage("---\n- one\n- two\n---\n\n# A\n", "fb");
    expect(page.frontmatter).toEqual({});
    expect(page.frontmatterError).toContain("list");
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

  // Quoting a scalar is a habit YAML actively encourages, and the constitution's
  // own example quotes `canonical_source`. Quoting a wikilink inside one used to
  // produce invalid YAML, so the page indexed with *zero* frontmatter: no type,
  // no provenance, no verified revision, and nothing for drift to hold on to.
  // These assert the whole record survives, not merely that parsing did not
  // throw — the field that goes missing is the one that matters.
  describe("a value the author already quoted", () => {
    const cases: [string, string, unknown][] = [
      ["a quoted scalar", 'title: "Radiative forcing, see also [[concepts/x]]"', undefined],
      ["a quoted list item", 'aliases: ["forcing", "see [[concepts/x]]"]', undefined],
      ["a defensively quoted wikilink", 'related: "[[concepts/x]]"', "[[concepts/x]]"],
      ["a quoted source field", 'source: "ipcc:ch07.md [[note]]"', undefined],
      ["a quoted block item", 'related:\n  - "[[concepts/x]]"', ["[[concepts/x]]"]],
    ];

    for (const [name, field, relatedValue] of cases) {
      test(`${name} keeps every other key`, () => {
        const page = parsePage(
          `---\n${field}\ntype: concept\ncanonical_source: "ipcc:ch07.md#L320"\nlast_verified_revision: 9a4f2c1\n---\n\n# X\n`,
          "fb",
        );

        expect(page.frontmatter.type).toBe("concept");
        expect(page.frontmatter.last_verified_revision).toBe("9a4f2c1");
        expect(page.frontmatter.canonical_source).toBeTruthy();
        if (relatedValue !== undefined) expect(page.frontmatter.related).toEqual(relatedValue);
      });
    }

    test("the quoted text is preserved verbatim, without injected quotes", () => {
      const page = parsePage('---\ntitle: "see [[concepts/x]]"\n---\n\n# X\n', "fb");
      expect(page.frontmatter.title).toBe("see [[concepts/x]]");
    });

    test("an escaped quote inside the value does not end it early", () => {
      const page = parsePage(
        '---\ntitle: "a \\" b [[concepts/x]]"\ntype: concept\n---\n\n# X\n',
        "fb",
      );
      expect(page.frontmatter.type).toBe("concept");
    });

    // Single quotes are deliberately not tracked: YAML gives `'` no special
    // meaning inside a plain scalar, so treating it as a delimiter would let the
    // apostrophe here open a run that never closes and swallow the wikilink.
    test("an apostrophe does not open a quoted run", () => {
      const page = parsePage(
        "---\ntitle: it's [[concepts/x]] here\ntype: concept\n---\n\n# X\n",
        "fb",
      );
      expect(page.frontmatter.type).toBe("concept");
      expect(String(page.frontmatter.title)).toContain("[[concepts/x]]");
    });
  });
});
