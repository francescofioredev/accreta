import { describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG, type AccretaConfig } from "../src/config.ts";
import { resolveWikilink, tryResolveWikilink } from "../src/links.ts";

const config: AccretaConfig = { ...DEFAULT_CONFIG, knowledgeBase: "knowledge" };

describe("resolveWikilink — path normalization", () => {
  // The regression this file exists for. A link written `[[../modules/foo]]`
  // renders and navigates correctly on GitHub, so the author sees nothing
  // wrong, while the resolved path `knowledge/../modules/foo.md` matches no
  // indexed page and the edge is silently absent from the graph. A shorter
  // consumer list is indistinguishable from a correct one.
  test("a '..' segment resolves to the same page as the direct target", () => {
    expect(resolveWikilink("../modules/foo", config)).toBe(resolveWikilink("modules/foo", config));
  });

  test("'..' does not survive into the resolved path", () => {
    expect(resolveWikilink("../modules/foo", config)).toBe("knowledge/modules/foo.md");
  });

  test("a './' prefix resolves", () => {
    expect(resolveWikilink("./concepts/x", config)).toBe("knowledge/concepts/x.md");
  });

  test("interior '..' segments collapse", () => {
    expect(resolveWikilink("concepts/../modules/foo", config)).toBe("knowledge/modules/foo.md");
  });

  test("interior '.' segments collapse", () => {
    expect(resolveWikilink("concepts/./x", config)).toBe("knowledge/concepts/x.md");
  });

  test("a target already rooted at the knowledge base normalizes too", () => {
    expect(resolveWikilink("knowledge/../modules/foo", config)).toBe("knowledge/modules/foo.md");
  });
});

describe("resolveWikilink — targets that leave the knowledge base", () => {
  test("a target climbing further than the knowledge base is deep is reported", () => {
    const result = tryResolveWikilink("../../etc/passwd", config);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("escapes-knowledge-base");
      expect(result.target).toBe("../../etc/passwd");
    }
  });

  test("an escape is reported rather than silently producing an unmatchable path", () => {
    // The failure mode this whole file exists to prevent: a resolver that
    // returns `knowledge/../../etc/passwd.md` matches nothing, and nothing says so.
    expect(tryResolveWikilink("../../../secrets", config).ok).toBe(false);
  });

  test("an empty target is reported", () => {
    expect(tryResolveWikilink("   ", config).ok).toBe(false);
  });

  test("a single leading '..' is the author writing relative to their own page, not an escape", () => {
    const result = tryResolveWikilink("../modules/foo", config);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.path).toBe("knowledge/modules/foo.md");
  });

  test("with a nested knowledge base, deeper climbs are still legitimate", () => {
    const nested: AccretaConfig = { ...config, knowledgeBase: "docs/knowledge" };
    const result = tryResolveWikilink("../../modules/foo", nested);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.path).toBe("docs/knowledge/modules/foo.md");
  });
});
