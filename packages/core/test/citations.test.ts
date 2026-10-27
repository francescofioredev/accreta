import { describe, expect, test } from "bun:test";
import { compileCitationTemplate, extractFootnotes, readFootnotes } from "../src/citations.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { formatCitation } from "../src/source/adapter.ts";

function reader(format: string) {
  const compiled = compileCitationTemplate(format);
  if (!compiled.ok) throw new Error(compiled.reason);
  return compiled.template;
}

describe("compileCitationTemplate", () => {
  const parts = { source: "got", rev: "b1d61c1", path: "source/index.ts", locator: "L5-L11" };

  test("reads back what the default format renders, with and without a locator", () => {
    const template = reader(DEFAULT_CONFIG.provenanceFormat);
    expect(template.read(formatCitation(DEFAULT_CONFIG.provenanceFormat, parts))).toEqual({
      sourceId: "got",
      revision: "b1d61c1",
      path: "source/index.ts",
      locator: "L5-L11",
    });
    const { locator: _, ...whole } = parts;
    expect(template.read(formatCitation(DEFAULT_CONFIG.provenanceFormat, whole))).toEqual({
      sourceId: "got",
      revision: "b1d61c1",
      path: "source/index.ts",
    });
  });

  test("reads a custom format the same way", () => {
    const format = "{path}#{locator} in {source} at {rev}";
    expect(reader(format).read(formatCitation(format, parts))).toEqual({
      sourceId: "got",
      revision: "b1d61c1",
      path: "source/index.ts",
      locator: "L5-L11",
    });
  });

  test("a format without {rev} reads citations that name no revision", () => {
    expect(reader("{source} · {path}#{locator}").read("got · a.ts#L1")).toEqual({
      sourceId: "got",
      revision: null,
      path: "a.ts",
      locator: "L1",
    });
  });

  test("the retired L{start}-L{end} reads as the locator it always rendered", () => {
    expect(reader("{source} @ {rev} · {path}#L{start}-L{end}").read("s @ r · a.txt#L5-L9")).toEqual(
      {
        sourceId: "s",
        revision: "r",
        path: "a.txt",
        locator: "L5-L9",
      },
    );
    expect(compileCitationTemplate("{path} from {start} in {source}").ok).toBe(false);
  });

  test("a format that would have to guess is refused with a reason", () => {
    const adjacent = compileCitationTemplate("{source}{path}");
    expect(adjacent.ok).toBe(false);
    if (!adjacent.ok) expect(adjacent.reason).toContain("side by side");

    const nameless = compileCitationTemplate("{rev} · {path}");
    expect(nameless.ok).toBe(false);
    if (!nameless.ok) expect(nameless.reason).toContain("{source}");
  });

  test("text in another shape does not read", () => {
    const template = reader(DEFAULT_CONFIG.provenanceFormat);
    expect(template.read("got @ b1d61c1 · source/index.ts#L5 and more prose")).toBeNull();
  });

  test("a prose footnote is not a citation attempt, a mangled citation is", () => {
    const template = reader(DEFAULT_CONFIG.provenanceFormat);
    expect(template.attempts("See the discussion in the design notes.")).toBe(false);
    expect(template.attempts("got @ b1d61c1 · ")).toBe(true);
  });

  test("a footnote written in an earlier format is still an attempt", () => {
    const template = reader(DEFAULT_CONFIG.provenanceFormat);
    expect(template.attempts("s · doc.md#L1")).toBe(true);
    expect(template.attempts("s: docs/a b.md#L2-L9.")).toBe(true);
  });

  test("a prose footnote with a link in it is still not an attempt", () => {
    const template = reader(DEFAULT_CONFIG.provenanceFormat);
    for (const prose of [
      "See the appendix.",
      "Background at https://example.com/guide#setup.",
      "Compare [[forcing#history]].",
      "See [the guide](guide.md#setup).",
      "Written in C# and F#.",
      "Fixed in acme/api#412.",
      "Needs C#10 or later.",
      "Reverted pre-#125.",
    ]) {
      expect(template.attempts(prose)).toBe(false);
    }
  });

  test("a long run of punctuation is checked in linear time", () => {
    const template = reader(DEFAULT_CONFIG.provenanceFormat);
    const started = performance.now();
    expect(template.attempts(`x a#b${".".repeat(1_000_000)}]`)).toBe(false);
    expect(performance.now() - started).toBeLessThan(500);
  });
});

describe("formatCitation", () => {
  test("renders $ patterns and placeholders in a value verbatim", () => {
    const format = "{source} @ {rev} · {path}#{locator}";
    expect(formatCitation(format, { source: "$&", rev: "$`", path: "$'", locator: "{rev}" })).toBe(
      "$& @ $` · $'#{rev}",
    );
    expect(formatCitation(format, { source: "s", rev: "{path}", path: "{locator}" })).toBe(
      "s @ {path} · {locator}",
    );
  });

  test("leaves a placeholder it does not know as written", () => {
    expect(formatCitation("{path}:{start}", { source: "s", rev: "r", path: "a.md" })).toBe(
      "a.md:{start}",
    );
  });

  test("leaves a placeholder an untyped caller gave no value for, dropping only {locator}", () => {
    const parts = { path: "a.md" } as unknown as Parameters<typeof formatCitation>[1];
    expect(formatCitation("{source} @ {rev} · {path}#{locator}", parts)).toBe(
      "{source} @ {rev} · a.md",
    );
  });
});

describe("extractFootnotes", () => {
  test("each definition comes with its line and the sentence that cites it", () => {
    const body = [
      "# Title",
      "",
      "Retries default to two.[^retry] Hooks run in order.",
      "The timeout is unset[^timeout], and",
      "applies per request.",
      "",
      "[^retry]: got @ abc · source/a.ts#L1-L3",
      "[^timeout]: got @ abc · source/b.ts#L9",
    ].join("\n");
    expect(extractFootnotes(body)).toEqual([
      {
        id: "retry",
        line: 7,
        text: "got @ abc · source/a.ts#L1-L3",
        claim: "Retries default to two.",
      },
      {
        id: "timeout",
        line: 8,
        text: "got @ abc · source/b.ts#L9",
        claim: "The timeout is unset, and applies per request.",
      },
    ]);
  });

  test("a footnote cited twice keeps both claims", () => {
    const body = "A holds.[^s]\n\nB holds too.[^s]\n\n[^s]: s @ r · p.md#L1";
    expect(extractFootnotes(body)[0]?.claim).toBe("A holds.\nB holds too.");
  });

  test("definitions inside a code fence are examples, not citations", () => {
    const body = "```markdown\n[^x]: s @ r · p.md#L1\n```\n";
    expect(extractFootnotes(body)).toEqual([]);
  });
});

describe("readFootnotes", () => {
  test("a reference on a definition's indented continuation leads from that definition", () => {
    const body = [
      "A claim.[^a]",
      "",
      "[^a]: s @ r · p.md#L1",
      "    read alongside [^b].",
      "[^b]: s @ r · p.md#L2",
      "[^c]: s @ r · p.md#L3",
      "    which cites [^d].",
      "[^d]: s @ r · p.md#L4",
    ].join("\n");
    expect(readFootnotes(body).orphans).toEqual([
      { id: "c", line: 6, role: "definition" },
      { id: "d", line: 8, role: "definition" },
    ]);
  });

  test("an unindented line right after a definition continues it, as GFM reads it", () => {
    const body = "[^a]: s @ r · p.md#L1\nLazy prose.[^a]";
    expect(readFootnotes(body).orphans).toEqual([{ id: "a", line: 1, role: "definition" }]);
  });

  test("an unindented line after a blank line is a claim again", () => {
    const body = "[^a]: s @ r · p.md#L1\n\nLater prose.[^a]";
    expect(readFootnotes(body).orphans).toEqual([]);
    expect(readFootnotes(body).footnotes[0]?.claim).toBe("Later prose.");
  });

  test("ids pair as GFM renderers fold labels", () => {
    for (const [ref, def] of [
      ["A", "a"],
      ["\u00c9", "\u00e9"],
      ["STRASSE", "stra\u00dfe"],
      ["\u03a3", "\u03c2"],
      ["\ufb01x", "fix"],
    ]) {
      const body = `Claim.[^${ref}]\n\n[^${def}]: s @ r · p.md#L1`;
      expect({ ref, orphans: readFootnotes(body).orphans }).toEqual({ ref, orphans: [] });
      expect(readFootnotes(body).footnotes[0]?.claim).toBe("Claim.");
    }
  });

  test("a decomposed and a precomposed letter are different ids, as on GitHub", () => {
    const body = "Claim.[^\u00e9]\n\n[^e\u0301]: s @ r · p.md#L1";
    expect(readFootnotes(body).orphans.map((o) => o.role)).toEqual(["reference", "definition"]);
  });

  test("a heading or list item directly under a definition ends it", () => {
    for (const start of ["## Next", "- item", "1. item", "> quote", "---\nBody"]) {
      const body = `A claim.[^a]\n\n[^a]: s @ r · p.md#L1\n${start} cites.[^b]\n\n[^b]: s @ r · p.md#L2`;
      const claim = readFootnotes(body).footnotes[1]?.claim ?? "";
      expect({ start, claim: claim.endsWith("cites.") }).toEqual({ start, claim: true });
    }
  });

  test("an escaped marker is not a reference", () => {
    expect(readFootnotes("Write \\[^x] to cite.").orphans).toEqual([]);
  });

  test("a marker in inline code is not a claim, and the code stays in the claim", () => {
    const body =
      "Write `[^a]` to cite.\n\nUse `x[^a]` here.[^b]\n\n[^a]: s @ r · p.md#L1\n[^b]: s @ r · p.md#L2";
    const [a, b] = readFootnotes(body).footnotes;
    expect(a?.claim).toBe("");
    expect(b?.claim).toBe("Use `x[^a]` here.");
  });

  test("a reference on a definition's continuation is not stored as body prose", () => {
    const body =
      "A claim.[^a]\n\n[^a]: s @ r · p.md#L1\n    read alongside [^b].\n[^b]: s @ r · p.md#L2";
    expect(readFootnotes(body).footnotes[1]?.claim).toBe("");
  });
});
