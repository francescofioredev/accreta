import { describe, expect, test } from "bun:test";
import { printable, printableBlock } from "../src/commands/shared.ts";

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
});

describe("printableBlock", () => {
  test("keeps lines, tabs, backslashes and format characters other than bidi controls", () => {
    const prose = "one\n\ttwo \\n\nthree\u200b\u200d\u{e0041}";
    expect(printableBlock(prose)).toBe(prose);
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
