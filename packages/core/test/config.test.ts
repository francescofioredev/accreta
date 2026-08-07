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
