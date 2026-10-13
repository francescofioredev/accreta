import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { kindFor } from "@accreta/adapters";
import { CONFIG_FILENAME } from "../workspace.ts";
import { composeConstitution, isPreset, PRESETS, type Preset } from "../constitution.ts";
import type { CommandContext } from "./shared.ts";

/** What a preset writes into the config. */
export interface PresetVocabulary {
  knowledgeBase: string;
  pageTypes: readonly string[];
  linkFields: readonly string[];
  provenanceFormat: string;
}

export const PRESET_VOCABULARY: Readonly<Record<Preset, PresetVocabulary>> = {
  codebase: {
    knowledgeBase: "knowledge",
    pageTypes: [
      "repository",
      "module",
      "api",
      "usecase",
      "concept",
      "decision",
      "integration",
      "synthesis",
    ],
    linkFields: [
      "consumers",
      "consumed_by",
      "delegates_to",
      "implements",
      "supersedes",
      "superseded_by",
      "related",
      "discussed_in",
    ],
    provenanceFormat: "{source} @ {rev} · {path}#{locator}",
  },
  research: {
    knowledgeBase: "knowledge",
    pageTypes: ["source", "concept", "finding", "method", "contradiction", "synthesis"],
    linkFields: [
      "cites",
      "cited_by",
      "supports",
      "contradicts",
      "supersedes",
      "superseded_by",
      "related",
      "discussed_in",
    ],
    provenanceFormat: "{source} @ {rev} · {path}#{locator}",
  },
};

export type VocabularyComposition =
  { vocabulary: PresetVocabulary; clash?: undefined } | { vocabulary?: undefined; clash: string };

/**
 * The union of several presets' vocabularies, in the order given and then each preset's own.
 * A shared name dedupes; a setting two presets give different values is refused, never merged.
 */
export function composeVocabulary(
  presets: readonly { name: string; vocabulary: PresetVocabulary }[],
): VocabularyComposition {
  const [first, ...rest] = presets;
  if (!first) return { clash: "No preset to compose." };
  const settings = [
    ["knowledge_base", (v: PresetVocabulary) => v.knowledgeBase],
    ["provenance.format", (v: PresetVocabulary) => v.provenanceFormat],
  ] as const;
  for (const [key, read] of settings) {
    const other = rest.find((preset) => read(preset.vocabulary) !== read(first.vocabulary));
    if (other) {
      return {
        clash:
          `Presets "${first.name}" and "${other.name}" set ${key} differently ` +
          `("${read(first.vocabulary)}" and "${read(other.vocabulary)}"). ` +
          `Not picking one: compose the config by hand.`,
      };
    }
  }
  const union = (read: (v: PresetVocabulary) => readonly string[]) => [
    ...new Set(presets.flatMap((preset) => read(preset.vocabulary))),
  ];
  return {
    vocabulary: {
      ...first.vocabulary,
      pageTypes: union((v) => v.pageTypes),
      linkFields: union((v) => v.linkFields),
    },
  };
}

/** `the "a" preset`, or `the "a" and "b" presets`. */
function describePresets(names: readonly string[]): string {
  const quoted = names.map((name) => `"${name}"`);
  return quoted.length === 1
    ? `the ${quoted[0]} preset`
    : `the ${quoted.slice(0, -1).join(", ")} and ${quoted.at(-1)} presets`;
}

function renderConfig(names: readonly string[], vocabulary: PresetVocabulary): string {
  const list = (items: readonly string[]) => items.map((item) => `  - ${item}\n`).join("");
  return `# The vocabulary of this knowledge base — ${describePresets(names)}.

knowledge_base: ${vocabulary.knowledgeBase}

page_types:
${list(vocabulary.pageTypes)}
link_fields:
${list(vocabulary.linkFields)}
provenance:
  format: "${vocabulary.provenanceFormat}"
`;
}

/** Split `--preset a,b` into known, distinct preset names, or say why not. */
export function parsePresets(value: string): { presets: Preset[] } | { error: string } {
  const presets: Preset[] = [];
  for (const item of value.split(",").map((part) => part.trim())) {
    if (item === "") return { error: `--preset "${value}" has an empty item.` };
    if (!isPreset(item)) {
      return { error: `Unknown preset "${item}". Available: ${PRESETS.join(", ")}.` };
    }
    if (presets.includes(item)) return { error: `--preset names "${item}" twice.` };
    presets.push(item);
  }
  return { presets };
}

const CONFIG_TEMPLATE = `# The vocabulary of this knowledge base.
#
# Page types and link fields live here rather than in the code, so a knowledge
# base about any subject can describe itself in its own terms.

knowledge_base: knowledge

page_types:
  - note
  - source
  - concept
  - decision
  - synthesis

link_fields:
  - related
  - supersedes
  - superseded_by
  - discussed_in

provenance:
  format: "{source} @ {rev} · {path}#{locator}"
`;

export interface InitOptions {
  preset?: string;
  /** Filename for the generated constitution. */
  agentFile?: string;
}

export function init(ctx: CommandContext, options: InitOptions = {}): number {
  const root = ctx.cwd;
  const configPath = join(root, CONFIG_FILENAME);

  let presets: Preset[] = [];
  let config = CONFIG_TEMPLATE;
  if (options.preset !== undefined) {
    const parsed = parsePresets(options.preset);
    if ("error" in parsed) {
      ctx.err(parsed.error);
      return 2;
    }
    presets = parsed.presets;
    const composed = composeVocabulary(
      presets.map((name) => ({ name, vocabulary: PRESET_VOCABULARY[name] })),
    );
    if (composed.clash !== undefined) {
      ctx.err(composed.clash);
      return 2;
    }
    config = renderConfig(presets, composed.vocabulary);
  }

  if (existsSync(configPath)) {
    ctx.err(`${CONFIG_FILENAME} already exists. Leaving it alone.`);
    return 1;
  }

  writeFileSync(configPath, config, "utf-8");
  mkdirSync(join(root, "knowledge"), { recursive: true });
  mkdirSync(join(root, "sources"), { recursive: true });

  const examplePath = join(root, "sources", "example.yaml");
  if (!existsSync(examplePath))
    writeFileSync(examplePath, kindFor("fs")!.template("example"), "utf-8");

  // The constitution is written only if nothing is there to overwrite. An
  // existing AGENTS.md or CLAUDE.md is somebody's work, and init is not the
  // place to discover that the hard way.
  const agentFile = options.agentFile ?? "AGENTS.md";
  const agentPath = join(root, agentFile);
  if (existsSync(agentPath)) {
    ctx.err(`${agentFile} already exists. Not overwriting it.`);
    ctx.err(`The composed constitution would have gone there; write it by hand if you want it.`);
  } else {
    writeFileSync(agentPath, composeConstitution({ presets, filename: agentFile }), "utf-8");
  }

  ctx.out(`Created ${CONFIG_FILENAME}, knowledge/, sources/ and ${agentFile}.`);
  if (presets.length > 0) ctx.out(`Vocabulary and constitution use ${describePresets(presets)}.`);
  ctx.out("Describe a source in sources/, then run `accreta reindex`.");
  return 0;
}
