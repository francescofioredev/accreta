import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig } from "@accreta/core";
import { run } from "../src/main.ts";
import { composeConstitution, PRESETS } from "../src/constitution.ts";
import {
  composeVocabulary,
  PRESET_VOCABULARY,
  type PresetVocabulary,
} from "../src/commands/init.ts";
import type { CommandContext } from "../src/commands.ts";

const TEMPLATES = join(import.meta.dir, "..", "..", "..", "templates", "constitution");

let root = "";
let output: string[] = [];
let errors: string[] = [];

function cli(...argv: string[]): Promise<number> {
  const ctx: CommandContext = {
    cwd: root,
    out: (line) => output.push(line),
    err: (line) => errors.push(line),
  };
  return run(argv, ctx);
}

const read = (file: string) => readFileSync(join(root, file), "utf-8");

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "accreta-init-presets-"));
  output = [];
  errors = [];
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

// The bytes `init --preset <one>` wrote before presets composed.
const SINGLE_PRESET_CONFIG: Record<string, string> = {
  codebase: `# The vocabulary of this knowledge base — the "codebase" preset.

knowledge_base: knowledge

page_types:
  - repository
  - module
  - api
  - usecase
  - concept
  - decision
  - integration
  - synthesis

link_fields:
  - consumers
  - consumed_by
  - delegates_to
  - implements
  - supersedes
  - superseded_by
  - related
  - discussed_in

provenance:
  format: "{source} @ {rev} · {path}#{locator}"
`,
  research: `# The vocabulary of this knowledge base — the "research" preset.

knowledge_base: knowledge

page_types:
  - source
  - concept
  - finding
  - method
  - contradiction
  - synthesis

link_fields:
  - cites
  - cited_by
  - supports
  - contradicts
  - supersedes
  - superseded_by
  - related
  - discussed_in

provenance:
  format: "{source} @ {rev} · {path}#{locator}"
`,
};

describe("init with one preset", () => {
  for (const preset of PRESETS) {
    test(`--preset ${preset} writes what it always did, byte for byte`, async () => {
      expect(await cli("init", "--preset", preset)).toBe(0);
      expect(read("accreta.config.yaml")).toBe(SINGLE_PRESET_CONFIG[preset]!);

      const section = readFileSync(join(TEMPLATES, "presets", `${preset}.md`), "utf-8").trim();
      const expected = composeConstitution().replace(
        "\n\n---\n\n<!-- composed from: base.md -->\n",
        `\n\n---\n\n${section}\n\n---\n\n<!-- composed from: base.md + presets/${preset}.md -->\n`,
      );
      expect(read("AGENTS.md")).toBe(expected);
      expect(output[1]).toBe(`Vocabulary and constitution use the "${preset}" preset.`);
    });
  }
});

describe("init with several presets", () => {
  test("the config is the union, in the order given and then each preset's own", async () => {
    expect(await cli("init", "--preset", "research,codebase")).toBe(0);
    const config = parseConfig(read("accreta.config.yaml"));
    const types = "source concept finding method contradiction synthesis repository module api";
    expect(config.pageTypes).toEqual(`${types} usecase decision integration`.split(" "));
    const fields = "cites cited_by supports contradicts supersedes superseded_by related";
    expect(config.linkFields).toEqual(
      `${fields} discussed_in consumers consumed_by delegates_to implements`.split(" "),
    );
    expect(read("accreta.config.yaml")).toStartWith(
      `# The vocabulary of this knowledge base — the "research" and "codebase" presets.\n`,
    );
  });

  test("the constitution is the base, then each preset's section once, in the order given", async () => {
    expect(await cli("init", "--preset", "research,codebase")).toBe(0);
    const text = read("AGENTS.md");
    const research = text.indexOf("# Preset: research literature");
    const codebase = text.indexOf("# Preset: source code");
    expect(text.indexOf("Every non-trivial claim carries a citation")).toBeLessThan(research);
    expect(research).toBeLessThan(codebase);
    expect(text.lastIndexOf("# Preset: research literature")).toBe(research);
    expect(text.lastIndexOf("# Preset: source code")).toBe(codebase);
    expect(text).toContain("composed from: base.md + presets/research.md + presets/codebase.md");
    expect(output[1]).toBe(
      `Vocabulary and constitution use the "research" and "codebase" presets.`,
    );
  });

  const refusals: [string, string][] = [
    ["codebase,nonsense", 'Unknown preset "nonsense"'],
    ["codebase,", "empty item"],
    [",codebase", "empty item"],
    ["codebase,,research", "empty item"],
    ["codebase,research,codebase", 'names "codebase" twice'],
  ];
  for (const [value, message] of refusals) {
    test(`--preset ${value} is refused with exit 2, before anything is written`, async () => {
      expect(await cli("init", "--preset", value)).toBe(2);
      expect(errors.join("\n")).toContain(message);
      expect(existsSync(join(root, "accreta.config.yaml"))).toBe(false);
      expect(existsSync(join(root, "AGENTS.md"))).toBe(false);
    });
  }
});

describe("composeVocabulary", () => {
  const codebase = { name: "codebase", vocabulary: PRESET_VOCABULARY.codebase };

  test("a setting two presets give differently is refused, naming both", () => {
    const other: PresetVocabulary = { ...PRESET_VOCABULARY.research, provenanceFormat: "{path}" };
    const composed = composeVocabulary([codebase, { name: "fixture", vocabulary: other }]);
    expect(composed.vocabulary).toBeUndefined();
    expect(composed.clash).toContain('"codebase" and "fixture"');
    expect(composed.clash).toContain("provenance.format");
  });

  test("a different knowledge base directory is refused too", () => {
    const other: PresetVocabulary = { ...PRESET_VOCABULARY.research, knowledgeBase: "wiki" };
    const composed = composeVocabulary([codebase, { name: "fixture", vocabulary: other }]);
    expect(composed.clash).toContain("knowledge_base");
  });

  test("identical entries dedupe", () => {
    const composed = composeVocabulary([codebase, codebase]);
    expect(composed.vocabulary).toEqual(PRESET_VOCABULARY.codebase);
  });
});

describe("PRESET_VOCABULARY", () => {
  // The config init writes and the YAML the constitution shows must name the same vocabulary.
  for (const preset of PRESETS) {
    test(`matches the configuration in presets/${preset}.md`, () => {
      const text = readFileSync(join(TEMPLATES, "presets", `${preset}.md`), "utf-8");
      const yaml = text.slice(
        text.indexOf("```yaml") + 7,
        text.indexOf("```", text.indexOf("```yaml") + 7),
      );
      const shown = parseConfig(yaml);
      const { pageTypes, linkFields, provenanceFormat } = PRESET_VOCABULARY[preset];
      expect({ pageTypes, linkFields, provenanceFormat }).toEqual({
        pageTypes: shown.pageTypes,
        linkFields: shown.linkFields,
        provenanceFormat: shown.provenanceFormat,
      });
    });
  }
});
