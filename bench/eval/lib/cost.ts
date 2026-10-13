import type { ModelUsage, Session } from "./agent.ts";

/** USD per million tokens. */
export interface Price {
  input: number;
  cache_write_5m: number;
  cache_write_1h: number;
  cache_read: number;
  output: number;
  /** Claude 4.6 and later: `inference_geo: "us"` multiplies every category by 1.1. */
  usGeo: boolean;
}

// The one price table for the eval. Re-check at the source on the day of a run and update the date.
export const PRICES_SOURCE = "https://platform.claude.com/docs/en/about-claude/pricing";
export const PRICES_CHECKED = "2026-10-13";
export const US_GEO_MULTIPLIER = 1.1;
export const PRICES: Readonly<Record<string, Price>> = {
  "claude-opus-5-5": {
    input: 4,
    cache_write_5m: 5,
    cache_write_1h: 8,
    cache_read: 0.2,
    output: 20,
    usGeo: true,
  },
  "claude-sonnet-5-5": {
    input: 2,
    cache_write_5m: 2.5,
    cache_write_1h: 4,
    cache_read: 0.1,
    output: 10,
    usGeo: true,
  },
  // The tier for prompts up to 100K tokens. The tier above (0.50 / 0.625 / 1 / 0.05 / 2.50) is
  // priced per request, and aggregated `modelUsage` cannot tell which requests crossed it.
  "claude-haiku-5-5": {
    input: 0.1,
    cache_write_5m: 0.125,
    cache_write_1h: 0.2,
    cache_read: 0.01,
    output: 0.5,
    usGeo: true,
  },
  "claude-haiku-4-5": {
    input: 1,
    cache_write_5m: 1.25,
    cache_write_1h: 2,
    cache_read: 0.1,
    output: 5,
    usGeo: false,
  },
};

/** A model id as the CLI records it, without a trailing `[1m]`-style tag. */
const bare = (model: string) => model.replace(/\[[^\]]*\]$/, "");

/** The price of a model id, dated snapshot ids included; an unpriced model is an error, never free. */
export function priceOf(model: string): Price {
  const m = bare(model);
  const id = Object.keys(PRICES)
    .filter((k) => m === k || m.startsWith(`${k}-`))
    .sort((a, b) => b.length - a.length)[0];
  if (id === undefined) throw new Error(`no price for model "${model}": add it to PRICES`);
  return PRICES[id]!;
}

// Geography is read from `usage`, the main model's, and applied to every model; Haiku's background calls are negligible.
function geoMultiplier(s: Session, p: Price): number {
  const geo = s.usage.inference_geo;
  if (geo === undefined || geo === "global" || geo === "not_available") return 1;
  if (geo === "us") return p.usGeo ? US_GEO_MULTIPLIER : 1;
  throw new Error(`inference_geo "${geo}" has no known price multiplier`);
}

interface Tokens {
  input: number;
  write: number;
  read: number;
  output: number;
}

const fromModelUsage = (m: ModelUsage): Tokens => ({
  input: m.inputTokens,
  write: m.cacheCreationInputTokens,
  read: m.cacheReadInputTokens,
  output: m.outputTokens,
});

const volume = (m: ModelUsage) =>
  m.inputTokens + m.cacheCreationInputTokens + m.cacheReadInputTokens + m.outputTokens;

/**
 * The model `usage` describes: the session's own, else the `modelUsage` entry with the most tokens.
 * Not an exact token match: a compaction can make `usage` and `modelUsage` differ (bench/jev's r-c run 1).
 */
function usageModel(s: Session): string | undefined {
  const entries = Object.entries(s.modelUsage ?? {});
  if (s.model) {
    const own = entries.find(([id, m]) => priceOf(m.canonicalModel ?? id) === priceOf(s.model!));
    if (own) return own[0];
  }
  return entries.toSorted(([, a], [, b]) => volume(b) - volume(a))[0]?.[0] ?? s.model;
}

/** Share of cache writes at the 1-hour rate, from `usage`'s split; no split, no guess. */
function oneHourShare(s: Session, writes: number): number {
  if (writes === 0) return 0;
  const split = s.usage.cache_creation;
  const h1 = split?.ephemeral_1h_input_tokens;
  const m5 = split?.ephemeral_5m_input_tokens;
  if (h1 === undefined || m5 === undefined || h1 + m5 === 0) {
    throw new Error(`session ${s.item}: cache writes without a 5m/1h split cannot be priced`);
  }
  return h1 / (h1 + m5);
}

/**
 * A session's cost recomputed from its recorded tokens, per model. The 5m/1h split in `usage`
 * applies only to the model `usage` describes; other models' writes are priced at 5 minutes.
 */
export function sessionCost(s: Session): number {
  const described = usageModel(s);
  const usd = (model: string, t: Tokens, share: number) => {
    const p = priceOf(model);
    const write = share * p.cache_write_1h + (1 - share) * p.cache_write_5m;
    const base = t.input * p.input + t.write * write + t.read * p.cache_read + t.output * p.output;
    return (base / 1e6) * geoMultiplier(s, p);
  };
  const entries = Object.entries(s.modelUsage ?? {});
  if (entries.length > 0) {
    return entries.reduce((sum, [id, m]) => {
      const model = m.canonicalModel ?? id;
      const share = id === described ? oneHourShare(s, m.cacheCreationInputTokens) : 0;
      return sum + usd(model, fromModelUsage(m), share);
    }, 0);
  }
  if (!s.model) throw new Error(`session ${s.item}: no model and no modelUsage to price`);
  const u = s.usage;
  const t = {
    input: u.input_tokens,
    write: u.cache_creation_input_tokens,
    read: u.cache_read_input_tokens,
    output: u.output_tokens,
  };
  return usd(s.model, t, oneHourShare(s, t.write));
}

export interface CostCounts {
  pages: number;
  resolvingFootnotes: number;
  citedClaims: number;
  /** Share of cited claims a support audit found supported; omitted until the audit is done. */
  supportRate?: number;
}

export interface CostReport {
  sessions: number;
  usd: number;
  /** What the CLI reported. Agreement checks the token accounting, not the prices. */
  cliUsd: number;
  counts: CostCounts;
  perPage: number;
  perResolvingFootnote: number;
  perCitedClaim: number;
  /** model-routing.md's unit of value: a claim its cited lines support. */
  perSupportedClaim: number;
  prices: { source: string; checked: string };
}

/** One arm's sessions; without `arm`, the file must hold a single arm, so arms never pool. */
export function sessionsOfArm(sessions: readonly Session[], arm?: string): Session[] {
  if (arm !== undefined) {
    const mine = sessions.filter((s) => s.arm === arm);
    if (mine.length === 0) throw new Error(`no sessions for arm "${arm}"`);
    return mine;
  }
  const arms = new Set(sessions.map((s) => s.arm));
  if (arms.size > 1) throw new Error(`sessions from ${arms.size} arms: pass --arm`);
  return [...sessions];
}

export function costReport(sessions: readonly Session[], counts: CostCounts): CostReport {
  const rate = counts.supportRate;
  if (rate !== undefined && !(rate >= 0 && rate <= 1)) {
    throw new Error(`support rate must be between 0 and 1, not ${rate}`);
  }
  const usd = sessions.reduce((s, x) => s + sessionCost(x), 0);
  const per = (n: number) => (n > 0 ? usd / n : NaN);
  return {
    sessions: sessions.length,
    usd,
    cliUsd: sessions.reduce((s, x) => s + (x.total_cost_usd ?? 0), 0),
    counts,
    perPage: per(counts.pages),
    perResolvingFootnote: per(counts.resolvingFootnotes),
    perCitedClaim: per(counts.citedClaims),
    perSupportedClaim:
      counts.supportRate === undefined ? NaN : per(counts.citedClaims * counts.supportRate),
    prices: { source: PRICES_SOURCE, checked: PRICES_CHECKED },
  };
}
