import { parse as parseYaml } from "yaml";

/**
 * The vocabulary of a knowledge base.
 *
 * Page types and link fields are configuration rather than constants because a
 * knowledge base about climate science should not have to describe itself with
 * page types invented for source code. The reference implementation this was
 * extracted from hardcoded its types in three separate places, and they drifted
 * apart exactly as you would expect.
 */
export interface AccretaConfig {
  /** Directory holding the markdown pages, relative to the project root. */
  knowledgeBase: string;
  /** Permitted values of the frontmatter `type` field. */
  pageTypes: string[];
  /** Frontmatter fields whose values are typed links to other pages. */
  linkFields: string[];
  /** Template used to render a provenance citation. */
  provenanceFormat: string;
}

export const DEFAULT_CONFIG: AccretaConfig = {
  knowledgeBase: "knowledge",
  pageTypes: ["note", "source", "concept", "decision", "synthesis"],
  linkFields: ["related", "supersedes", "superseded_by", "discussed_in"],
  provenanceFormat: "{source} @ {rev} · {path}#{locator}",
};

function asStringArray(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return fallback;
  const out = value.filter((v): v is string => typeof v === "string" && v.length > 0);
  return out.length > 0 ? out : fallback;
}

function asString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

/**
 * Build a config from already-parsed YAML data.
 *
 * Every field falls back to the default independently, so a partial config file
 * is valid: a knowledge base that only wants to override `page_types` should not
 * have to restate the rest of the vocabulary.
 */
export function configFromObject(data: unknown): AccretaConfig {
  if (!data || typeof data !== "object" || Array.isArray(data)) return { ...DEFAULT_CONFIG };
  const raw = data as Record<string, unknown>;
  const provenance =
    raw.provenance && typeof raw.provenance === "object" && !Array.isArray(raw.provenance)
      ? (raw.provenance as Record<string, unknown>)
      : {};

  return {
    knowledgeBase: asString(raw.knowledge_base, DEFAULT_CONFIG.knowledgeBase),
    pageTypes: asStringArray(raw.page_types, DEFAULT_CONFIG.pageTypes),
    linkFields: asStringArray(raw.link_fields, DEFAULT_CONFIG.linkFields),
    provenanceFormat: asString(provenance.format, DEFAULT_CONFIG.provenanceFormat),
  };
}

/** Parse the text of an `accreta.config.yaml`. */
export function parseConfig(source: string): AccretaConfig {
  return checkConfig(source).config;
}

export interface ConfigCheck {
  config: AccretaConfig;
  /** Why the file could not be read, when it could not. */
  error?: string;
}

/**
 * Parse a config and say whether it actually parsed.
 *
 * `parseConfig` degrades to defaults on a syntax error so that reading a page
 * never throws on the config, which is the right trade there and the wrong one
 * everywhere else: a knowledge base whose vocabulary silently reverted to the
 * defaults lints against page types nobody chose, and nothing says so. This is
 * how `doctor` can.
 */
export function checkConfig(source: string): ConfigCheck {
  let data: unknown;
  try {
    data = parseYaml(source);
  } catch (error) {
    return {
      config: { ...DEFAULT_CONFIG },
      error: error instanceof Error ? error.message : String(error),
    };
  }
  return { config: configFromObject(data) };
}
