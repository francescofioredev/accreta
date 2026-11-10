import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
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

// The repository's own config is the default vocabulary; it went stale once when the default grew.
test("the repository's accreta.config.yaml is the default vocabulary", () => {
  const raw = readFileSync(join(import.meta.dir, "..", "..", "..", "accreta.config.yaml"), "utf-8");
  expect(parseConfig(raw)).toEqual(DEFAULT_CONFIG);
});

describe("provenance.inference_marker and provenance.verdict_file", () => {
  const marker = (value: string) => parseConfig(`provenance:\n  inference_marker: ${value}\n`);

  test("a usable marker is kept", () => {
    expect(marker('"(my guess)"').inferenceMarker).toBe("(my guess)");
    expect(marker('"(my guess)"').inferenceMarkerRejected).toBeUndefined();
  });

  test.each(['"."', '")"', '"ab"', '"(...)"', '"a\\nb"', `"${"x".repeat(41)}"`])(
    "the degenerate marker %s falls back to the default and is named",
    (value) => {
      const config = marker(value);
      expect(config.inferenceMarker).toBe(DEFAULT_CONFIG.inferenceMarker);
      expect(config.inferenceMarkerRejected).toBeDefined();
    },
  );

  test("an empty marker is the default, not a refusal", () => {
    expect(marker('""').inferenceMarkerRejected).toBeUndefined();
  });

  test.each(['"/etc/verdicts.jsonl"', '"../out.jsonl"', '"a/../../b"'])(
    "a verdict file at %s is ignored",
    (value) => {
      expect(parseConfig(`provenance:\n  verdict_file: ${value}\n`).verdictFile).toBeUndefined();
    },
  );

  test("a relative verdict file is kept", () => {
    expect(parseConfig("provenance:\n  verdict_file: kb/v.jsonl\n").verdictFile).toBe("kb/v.jsonl");
  });
});
