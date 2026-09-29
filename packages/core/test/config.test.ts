import { describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG, parseConfig } from "../src/config.ts";

describe("parseConfig", () => {
  test("an empty config yields the defaults", () => {
    expect(parseConfig("")).toEqual(DEFAULT_CONFIG);
  });

  test("page types and link fields come from the file, not from constants", () => {
    const config = parseConfig(`
page_types: [paper, dataset, finding]
link_fields: [cites, contradicts]
`);
    expect(config.pageTypes).toEqual(["paper", "dataset", "finding"]);
    expect(config.linkFields).toEqual(["cites", "contradicts"]);
  });

  test("a partial config overrides only what it names", () => {
    const config = parseConfig("page_types: [note]");
    expect(config.pageTypes).toEqual(["note"]);
    expect(config.linkFields).toEqual(DEFAULT_CONFIG.linkFields);
    expect(config.knowledgeBase).toEqual(DEFAULT_CONFIG.knowledgeBase);
  });

  test("malformed YAML degrades to defaults rather than throwing", () => {
    expect(parseConfig("page_types: [unclosed")).toEqual(DEFAULT_CONFIG);
  });
});

describe("supersession_fields", () => {
  test("names the pair lint reads as supersession", () => {
    const config = parseConfig(`
link_fields: [replaces, replaced_by]
supersession_fields:
  supersedes: replaces
  superseded_by: replaced_by
`);
    expect(config.supersessionFields).toEqual({
      supersedes: "replaces",
      supersededBy: "replaced_by",
    });
  });

  test("absent, it stays unset so lint can tell the default from a choice", () => {
    expect(parseConfig("page_types: [note]")).not.toHaveProperty("supersessionFields");
  });

  test("false turns the check off", () => {
    expect(parseConfig("supersession_fields: false").supersessionFields).toBeNull();
  });

  // Defaulting would check a pair the user did not choose; lint reports the value instead.
  test("a malformed pair is kept as invalid, not replaced by the default", () => {
    for (const [value, raw] of [
      ["no", "no"],
      ["off", "off"],
      ["[supersedes, superseded_by]", ["supersedes", "superseded_by"]],
      ["{ supersedes: replaces }", { supersedes: "replaces" }],
      ["{ supersedes: same, superseded_by: same }", { supersedes: "same", superseded_by: "same" }],
      ["", null],
    ] as const) {
      expect(parseConfig(`supersession_fields: ${value}`).supersessionFields).toEqual({
        invalid: raw,
      });
    }
  });
});
