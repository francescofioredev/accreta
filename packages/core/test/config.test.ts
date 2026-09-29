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

  test("a malformed pair falls back to the default, like every other key", () => {
    for (const value of [
      "supersession_fields: yes please",
      "supersession_fields: [supersedes, superseded_by]",
      "supersession_fields: { supersedes: replaces }",
      "supersession_fields: { supersedes: same, superseded_by: same }",
      "supersession_fields:",
    ]) {
      expect(parseConfig(value)).not.toHaveProperty("supersessionFields");
    }
  });
});
