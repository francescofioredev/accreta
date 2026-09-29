import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { kindFor } from "@accreta/adapters";
import { CONFIG_FILENAME } from "../workspace.ts";
import { composeConstitution, isPreset, PRESETS, type Preset } from "../constitution.ts";
import type { CommandContext } from "./shared.ts";

function configTemplateFor(preset?: Preset): string {
  if (preset === "codebase") return CONFIG_CODEBASE;
  if (preset === "research") return CONFIG_RESEARCH;
  return CONFIG_TEMPLATE;
}

const CONFIG_CODEBASE = `# The vocabulary of this knowledge base — the "codebase" preset.

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
`;

const CONFIG_RESEARCH = `# The vocabulary of this knowledge base — the "research" preset.

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
`;

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

  if (existsSync(configPath)) {
    ctx.err(`${CONFIG_FILENAME} already exists. Leaving it alone.`);
    return 1;
  }

  let preset: Preset | undefined;
  if (options.preset !== undefined) {
    if (!isPreset(options.preset)) {
      ctx.err(`Unknown preset "${options.preset}". Available: ${PRESETS.join(", ")}.`);
      return 1;
    }
    preset = options.preset;
  }

  writeFileSync(configPath, configTemplateFor(preset), "utf-8");
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
    writeFileSync(agentPath, composeConstitution({ preset, filename: agentFile }), "utf-8");
  }

  ctx.out(`Created ${CONFIG_FILENAME}, knowledge/, sources/ and ${agentFile}.`);
  if (preset) ctx.out(`Vocabulary and constitution use the "${preset}" preset.`);
  ctx.out("Describe a source in sources/, then run `accreta reindex`.");
  return 0;
}
