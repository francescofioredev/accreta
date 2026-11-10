import { isAbsolute } from "node:path";
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
  /** Literal that ends a sentence declared as inference, which needs no footnote. */
  inferenceMarker: string;
  /** The `inference_marker` that was set but refused, so doctor can say the default is in force. */
  inferenceMarkerRejected?: string;
  /** Relative path of the verdict file; absent means `verdicts.jsonl` beside the pages. */
  verdictFile?: string;
  /** Whether lint reports prose sentences with neither a footnote nor the inference marker. */
  lintUncitedSentences: boolean;
  /** Page types `uncited-sentence` skips. */
  uncitedExemptTypes: string[];
  /** The link fields lint reads as supersession: undefined when not set, null when turned off. */
  supersessionFields?: SupersessionFields | InvalidSupersessionFields | null;
  /** The `judge:` block as written; absent when the file has none, which keeps the judge off. */
  judge?: JudgeBlock;
}

/** The `judge:` block as written. `resolveJudgeSettings` fills the defaults and the env overrides. */
export interface JudgeBlock {
  route?: string;
  url?: string;
  model?: string;
  apiKeyEnv?: string;
  rerankTop?: number;
  supportThreshold?: number;
  /** Dotted keys the block holds that no setting reads: a pasted secret is among them. */
  unknownKeys: string[];
  /** Dotted keys present with a value that cannot be used. */
  invalidKeys: string[];
}

/** A `supersession_fields` value that is set but is not a pair, kept so lint can say so. */
export interface InvalidSupersessionFields {
  invalid: unknown;
}

/** The two link fields that say one page replaced another, one from each side. */
export interface SupersessionFields {
  supersedes: string;
  supersededBy: string;
}

export const DEFAULT_CONFIG: AccretaConfig = {
  knowledgeBase: "knowledge",
  pageTypes: ["note", "source", "concept", "decision", "synthesis"],
  linkFields: ["related", "supersedes", "superseded_by", "amends", "amended_by", "discussed_in"],
  provenanceFormat: "{source} @ {rev} · {path}#{locator}",
  inferenceMarker: "(inference)",
  lintUncitedSentences: false,
  uncitedExemptTypes: [],
};

export const DEFAULT_SUPERSESSION_FIELDS: SupersessionFields = {
  supersedes: "supersedes",
  supersededBy: "superseded_by",
};

function asStringArray(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return fallback;
  const out = value.filter((v): v is string => typeof v === "string" && v.length > 0);
  return out.length > 0 ? out : fallback;
}

function asString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

// Unlike other keys a malformed pair is kept, not defaulted: checking the default pair would ignore an explicit choice.
function asSupersessionFields(
  value: unknown,
): SupersessionFields | InvalidSupersessionFields | null {
  if (value === false) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) return { invalid: value };
  const raw = value as Record<string, unknown>;
  const supersedes = asString(raw.supersedes, "");
  const supersededBy = asString(raw.superseded_by, "");
  if (!supersedes || !supersededBy || supersedes === supersededBy) return { invalid: value };
  return { supersedes, supersededBy };
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

  const lintBlock =
    raw.lint && typeof raw.lint === "object" && !Array.isArray(raw.lint)
      ? (raw.lint as Record<string, unknown>)
      : {};

  return {
    knowledgeBase: asString(raw.knowledge_base, DEFAULT_CONFIG.knowledgeBase),
    pageTypes: asStringArray(raw.page_types, DEFAULT_CONFIG.pageTypes),
    linkFields: asStringArray(raw.link_fields, DEFAULT_CONFIG.linkFields),
    provenanceFormat: asString(provenance.format, DEFAULT_CONFIG.provenanceFormat),
    ...markerFields(provenance.inference_marker),
    ...verdictFileField(provenance.verdict_file),
    lintUncitedSentences: lintBlock.uncited_sentences === true,
    uncitedExemptTypes: Array.isArray(lintBlock.uncited_exempt_types)
      ? lintBlock.uncited_exempt_types.filter((v): v is string => typeof v === "string")
      : [],
    ...("supersession_fields" in raw && {
      supersessionFields: asSupersessionFields(raw.supersession_fields),
    }),
    ...("judge" in raw && { judge: asJudgeBlock(raw.judge) }),
  };
}

// A marker that is one line with a letter or digit in it; "." or ")" would exempt nearly every sentence.
function markerFields(
  value: unknown,
): Pick<AccretaConfig, "inferenceMarker" | "inferenceMarkerRejected"> {
  const marker = asString(value, "").trim();
  if (marker === "") return { inferenceMarker: DEFAULT_CONFIG.inferenceMarker };
  const usable =
    [...marker].length >= 3 &&
    [...marker].length <= 40 &&
    !/[\p{Cc}\p{Zl}\p{Zp}]/u.test(marker) &&
    /[\p{L}\p{N}]/u.test(marker);
  return usable
    ? { inferenceMarker: marker }
    : { inferenceMarker: DEFAULT_CONFIG.inferenceMarker, inferenceMarkerRejected: marker };
}

function verdictFileField(value: unknown): Pick<AccretaConfig, "verdictFile"> {
  const path = asString(value, "").trim();
  return path !== "" && validVerdictPath(path) ? { verdictFile: path } : {};
}

function validVerdictPath(path: string): boolean {
  return (
    !isAbsolute(path) && !path.split(/[\\/]/).includes("..") && !/[\p{Cc}\p{Zl}\p{Zp}]/u.test(path)
  );
}

const JUDGE_KEYS = new Set(["route", "url", "model", "api_key_env", "rerank", "support"]);

function asJudgeBlock(value: unknown): JudgeBlock {
  const block: JudgeBlock = { unknownKeys: [], invalidKeys: [] };
  if (value === null || value === undefined) return block;
  if (typeof value !== "object" || Array.isArray(value)) {
    block.invalidKeys.push("judge");
    return block;
  }
  const raw = value as Record<string, unknown>;
  const text = (key: string): string | undefined => {
    if (!(key in raw) || raw[key] === null) return undefined;
    const v = raw[key];
    if (typeof v === "string" && v.trim().length > 0) return v.trim();
    block.invalidKeys.push(key);
    return undefined;
  };
  block.route = text("route");
  block.url = text("url");
  block.model = text("model");
  block.apiKeyEnv = text("api_key_env");

  const nested = (key: string, field: string, read: (v: unknown) => number | undefined) => {
    const inner = raw[key];
    if (inner === undefined || inner === null) return undefined;
    if (typeof inner !== "object" || Array.isArray(inner)) {
      block.invalidKeys.push(key);
      return undefined;
    }
    const fields = inner as Record<string, unknown>;
    for (const other of Object.keys(fields))
      if (other !== field) block.unknownKeys.push(`${key}.${other}`);
    if (!(field in fields)) return undefined;
    const parsed = read(fields[field]);
    if (parsed === undefined) block.invalidKeys.push(`${key}.${field}`);
    return parsed;
  };
  block.rerankTop = nested("rerank", "top", asRerankTop);
  block.supportThreshold = nested("support", "threshold", asThreshold);

  for (const key of Object.keys(raw)) if (!JUDGE_KEYS.has(key)) block.unknownKeys.push(key);
  return block;
}

/** How many of search's hits a judge may be asked about: search itself returns at most 50. */
export function asRerankTop(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 50
    ? value
    : undefined;
}

export function asThreshold(value: unknown): number | undefined {
  return typeof value === "number" && value > 0 && value <= 1 ? value : undefined;
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
