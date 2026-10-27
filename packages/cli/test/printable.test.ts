import { describe, expect, test } from "bun:test";
import { printable, printableBlock, printableMessage } from "../src/commands/shared.ts";

describe("printable", () => {
  test("escapes the backslash, every control and format character, and the line separators", () => {
    expect(printable("a\\u0041\n\t\u001b[2J\u202e\u200b\u200d\u{e0041}\u2028\u2029b")).toBe(
      "a\\\\u0041\\u000a\\u0009\\u001b[2J\\u202e\\u200b\\u200d\\u{e0041}\\u2028\\u2029b",
    );
  });

  test("escapes invisible characters outside Cf, so a path cannot pass for another", () => {
    expect(printable("a\ufe0f\u{e0100}\u180b\u034f\u115f\u3164\uffa0b")).toBe(
      "a\\ufe0f\\u{e0100}\\u180b\\u034f\\u115f\\u3164\\uffa0b",
    );
  });

  test("keeps an emoji's presentation selector", () => {
    expect(printable("\u26a0\ufe0f Deprecated \u2705\ufe0e a\ufe0f")).toBe(
      "\u26a0\ufe0f Deprecated \u2705\ufe0e a\\ufe0f",
    );
  });
});

describe("printableBlock", () => {
  test("keeps a subdivision flag, but not tag text dressed as one", () => {
    const england = "\u{1f3f4}\u{e0067}\u{e0062}\u{e0065}\u{e006e}\u{e0067}\u{e007f}";
    expect(printableBlock(england)).toBe(england);
    const smuggled = `\u{1f3f4}${"\u{e0069}".repeat(20)}\u{e007f}`;
    expect(printableBlock(smuggled)).not.toContain("\u{e0069}");
  });

  test("keeps lines, tabs, backslashes, joiners and presentation selectors", () => {
    const prose = "one\n\ttwo \\n\nthree\u200d\u200c \u26a0\ufe0f \u2705\ufe0e";
    expect(printableBlock(prose)).toBe(prose);
  });

  test("keeps a flag's tag sequence and escapes a tag character anywhere else", () => {
    const england = "\u{1f3f4}\u{e0067}\u{e0062}\u{e0065}\u{e006e}\u{e0067}\u{e007f}";
    expect(printableBlock(`${england} a\u{e0041}\u{e0042} \u{1f3f4}\u{e0041}`)).toBe(
      `${england} a\\u{e0041}\\u{e0042} \u{1f3f4}\\u{e0041}`,
    );
  });

  test("escapes invisible characters a model reads and a human cannot", () => {
    expect(printableBlock("a\u200b\u2060\u2061\u2062\u2063\u2064\ufeff\u00ad\u180eb")).toBe(
      "a\\u200b\\u2060\\u2061\\u2062\\u2063\\u2064\\ufeff\\u00ad\\u180eb",
    );
  });

  test("escapes variation selectors, Hangul fillers and the other invisibles", () => {
    expect(printableBlock("a\ufe00\u{e0100}\u3164\uffa0\u2065b")).toBe(
      "a\\ufe00\\u{e0100}\\u3164\\uffa0\\u2065b",
    );
  });

  test("reads CRLF as one line break", () => {
    expect(printableBlock("one\r\ntwo")).toBe("one\ntwo");
  });

  test("escapes the other controls, the bidi controls and the line separators", () => {
    const hostile =
      "\u001b[2J\r\u0085\u000b\u061c\u200e\u200f\u202a\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069\u2028\u2029";
    expect(printableBlock(hostile)).toBe(
      "\\u001b[2J\\u000d\\u0085\\u000b\\u061c\\u200e\\u200f\\u202a\\u202b\\u202c\\u202d\\u202e" +
        "\\u2066\\u2067\\u2068\\u2069\\u2028\\u2029",
    );
  });
});

describe("printableMessage", () => {
  test("escapes each line and marks every line after the first", () => {
    expect(printableMessage("one\r\n::warning::x\u001b\nok: y", "  ")).toBe(
      "one\n    | ::warning::x\\u001b\n    | ok: y",
    );
  });
});
