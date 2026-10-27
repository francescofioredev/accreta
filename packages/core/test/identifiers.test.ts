import { describe, expect, test } from "bun:test";
import { identifiersIn, visibleText } from "../src/identifiers.ts";

const ids = (body: string) => identifiersIn(visibleText(body));

describe("visibleText", () => {
  test("drops footnote definitions with their continuation, and keeps fenced code", () => {
    const body = [
      "Claim.[^a] kept_word",
      "",
      "[^a]: src @ abc · a_path.ts#L1",
      "    still_the_definition",
      "",
      "```",
      "<!-- kept_in_code -->",
      "[^b]: kept_in_code_too",
      "```",
    ].join("\n");
    expect(ids(body)).toEqual(["kept_word", "kept_in_code", "kept_in_code_too"]);
  });

  test("drops a closed comment, inline or across a paragraph's lines", () => {
    expect(ids("Kept_a <!-- gone_a --> kept_b.")).toEqual(["Kept_a", "kept_b"]);
    expect(ids("Kept_a <!-- gone_a\ngone_b --> kept_b.")).toEqual(["Kept_a", "kept_b"]);
  });

  test("an unclosed inline <!-- is text, and does not swallow what follows", () => {
    expect(ids("a <!-- b\nc_d")).toEqual(["c_d"]);
    expect(ids("A literal <!-- in prose.\n\nstale_served counts.")).toEqual(["stale_served"]);
    expect(ids("The arrow <!--- marks it. stale_served counts.")).toEqual(["stale_served"]);
    expect(ids("Write `<!--` to open a comment.\nstale_served counts.")).toEqual(["stale_served"]);
  });

  test("a comment that opens a line runs to the line holding -->, or to the end", () => {
    expect(ids("<!-->\nstale_served counts.")).toEqual(["stale_served"]);
    expect(ids("<!-- gone_a\ngone_b --> kept_a\nkept_b")).toEqual(["kept_a", "kept_b"]);
    expect(ids("kept_a\n\n<!-- gone_a\n\ngone_b")).toEqual(["kept_a"]);
  });

  test("drops link destinations and reference definitions, and keeps the link text", () => {
    expect(ids("See [the_counter](src/stale_served.ts#L3).")).toEqual(["the_counter"]);
    expect(ids('See [it](<src/a_b.ts> "a_title").')).toEqual([]);
    expect(ids("See [the counter][c].\n\n[c]: src/stale_served.ts")).toEqual([]);
    expect(ids("Text.\n\n[zz]: https://x.example/stale_served")).toEqual([]);
    expect(ids("See [text][stale_ref].")).toEqual([]);
  });

  test("drops a wikilink target behind a label, and keeps an unlabelled one", () => {
    expect(ids("See [[metrics/stale_served|the counter]].")).toEqual([]);
    expect(ids("See [[metrics/stale_served]].")).toEqual(["stale_served"]);
  });

  test("an identifier in a code span is kept", () => {
    expect(ids("`stale_served` counts and [`queue_depth`](src/q_d.ts) waits.")).toEqual([
      "stale_served",
      "queue_depth",
    ]);
  });
});
