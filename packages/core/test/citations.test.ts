import { describe, expect, test } from "bun:test";
import { compileCitationTemplate, extractFootnotes } from "../src/citations.ts";
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
