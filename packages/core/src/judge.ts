import { asRerankTop, asThreshold, type JudgeBlock } from "./config.ts";

/**
 * An optional judge: a model asked narrow questions about text, answered as probabilities.
 * It is advisory (ADR-0014): it never edits a page and never bumps `last_verified_revision`.
 * Core holds this port and never knows which implementation is behind it.
 */

/** Names the judge and the model version that answered, on every result (ADR-0014). */
export interface JudgeIdentity {
  /** The route that answered: `typesafe`, `cloudflare`, `local`. */
  judge: string;
  /** The model the server says it used; the requested one when the reply does not say. */
  model: string;
}

/** One page offered for ranking. `id` is the caller's own and comes back unchanged. */
export interface JudgeCandidate {
  id: string;
  title: string;
  summary: string;
}

/** P(this candidate is what the query asks for), in 0..1. */
export interface RankedCandidate extends JudgeIdentity {
  id: string;
  probability: number;
}

export type SupportVerdict = "supports" | "contradicts" | "says_nothing";

export const SUPPORT_VERDICTS: readonly SupportVerdict[] = [
  "supports",
  "contradicts",
  "says_nothing",
];

export interface SupportResult extends JudgeIdentity {
  /** The most probable of the three. */
  verdict: SupportVerdict;
  /** P(verdict). Compare P(supports) with the threshold, not this. */
  probability: number;
  probabilities: Record<SupportVerdict, number>;
}

export interface JudgeProbe extends JudgeIdentity {
  latencyMs: number;
}

export interface Judge {
  /** One probability per candidate, in the order given. Throws `JudgeUnavailableError`. */
  rank(query: string, candidates: readonly JudgeCandidate[]): Promise<RankedCandidate[]>;
  /** Does `citedText` support `claim`? The judge sees these two strings and nothing else. */
  supports(claim: string, citedText: string): Promise<SupportResult>;
  /** One cheap round trip, for `doctor`. */
  probe?(): Promise<JudgeProbe>;
}

/** The judge could not answer. Callers fall back to what they did without one and warn once. */
export class JudgeUnavailableError extends Error {
  override name = "JudgeUnavailableError";
}

/** The `judge:` block cannot make a judge. The message names the variable, never its value. */
export class JudgeConfigError extends Error {
  override name = "JudgeConfigError";
}

export const JUDGE_DEFAULTS = {
  apiKeyEnv: "ACCRETA_JUDGE_KEY",
  rerankTop: 20,
  // The study's value, on the cited lines only (docs/research/2026-09-jev, T2).
  supportThreshold: 0.73,
} as const;

export interface JudgeSettings {
  route?: string;
  url?: string;
  /** The url came from `ACCRETA_JUDGE_URL`, not from the file: only then may a key go to it. */
  urlFromEnv: boolean;
  model?: string;
  apiKeyEnv: string;
  rerankTop: number;
  supportThreshold: number;
  unknownKeys: string[];
  /** What is wrong with the settings, in words; empty when they can make a judge. */
  problems: string[];
}

type Env = Readonly<Record<string, string | undefined>>;

/**
 * The block with defaults and `ACCRETA_JUDGE_*` overrides applied; null when the file has no
 * `judge:` block, which is what keeps a knowledge base without one exactly as it was.
 */
export function resolveJudgeSettings(
  block: JudgeBlock | undefined,
  env: Env = {},
): JudgeSettings | null {
  if (!block) return null;
  const problems = block.invalidKeys.map((key) =>
    key === "judge" ? "judge is not a mapping" : `judge.${key} is not usable`,
  );
  const text = (name: string) => {
    const value = env[`ACCRETA_JUDGE_${name}`]?.trim();
    return value ? value : undefined;
  };
  const number = (name: string, read: (v: unknown) => number | undefined, label: string) => {
    const raw = text(name);
    if (raw === undefined) return undefined;
    const parsed = read(Number(raw));
    if (parsed === undefined) problems.push(`ACCRETA_JUDGE_${name} is not usable (${label})`);
    return parsed;
  };
  const settings: JudgeSettings = {
    route: text("ROUTE") ?? block.route,
    url: text("URL") ?? block.url,
    urlFromEnv: text("URL") !== undefined,
    model: text("MODEL") ?? block.model,
    apiKeyEnv: text("API_KEY_ENV") ?? block.apiKeyEnv ?? JUDGE_DEFAULTS.apiKeyEnv,
    rerankTop:
      number("RERANK_TOP", asRerankTop, "a whole number from 1 to 50") ??
      block.rerankTop ??
      JUDGE_DEFAULTS.rerankTop,
    supportThreshold:
      number("SUPPORT_THRESHOLD", asThreshold, "a number above 0 and at most 1") ??
      block.supportThreshold ??
      JUDGE_DEFAULTS.supportThreshold,
    unknownKeys: block.unknownKeys,
    problems,
  };
  if (!settings.route) problems.push("judge.route is not set");
  // A file in a cloned knowledge base must not be able to name GITHUB_TOKEN as the key to send.
  if (!settings.apiKeyEnv.startsWith("ACCRETA_"))
    problems.push("the api_key_env setting must name a variable starting with ACCRETA_");
  return settings;
}
