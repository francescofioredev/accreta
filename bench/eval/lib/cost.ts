import type { Session } from "./agent.ts";

/** USD per million tokens. */
export interface Price {
  input: number;
  cache_write_5m: number;
  cache_write_1h: number;
  cache_read: number;
  output: number;
}

// The one price table for the eval. Re-check at the source on the day of a run and update the date.
export const PRICES_SOURCE = "https://platform.claude.com/docs/en/about-claude/pricing";
export const PRICES_CHECKED = "2026-10-13";
export const PRICES: Readonly<Record<string, Price>> = {
  "claude-opus-5-5": {
    input: 4,
    cache_write_5m: 5,
    cache_write_1h: 8,
    cache_read: 0.2,
    output: 20,
  },
  "claude-sonnet-5-5": {
    input: 2,
    cache_write_5m: 2.5,
    cache_write_1h: 4,
    cache_read: 0.2,
    output: 10,
  },
  "claude-haiku-4-5": {
    input: 1,
    cache_write_5m: 1.25,
    cache_write_1h: 2,
    cache_read: 0.1,
    output: 5,
  },
};

/** The price of a model id, dated snapshot ids included; an unpriced model is an error, never free. */
export function priceOf(model: string): Price {
  const id = Object.keys(PRICES)
    .filter((k) => model === k || model.startsWith(`${k}-`))
    .sort((a, b) => b.length - a.length)[0];
  if (id === undefined) throw new Error(`no price for model "${model}": add it to PRICES`);
  return PRICES[id]!;
}

/** Share of cache writes at the 1-hour rate; `modelUsage` does not split them, `usage` does. */
function oneHourShare(s: Session): number {
  const split = s.usage.cache_creation;
  const total = (split?.ephemeral_1h_input_tokens ?? 0) + (split?.ephemeral_5m_input_tokens ?? 0);
  return total === 0 ? 0 : split!.ephemeral_1h_input_tokens! / total;
}

/** A session's cost recomputed from its recorded tokens, per model when the record has them. */
export function sessionCost(s: Session): number {
  const share = oneHourShare(s);
  const usd = (p: Price, t: { input: number; write: number; read: number; output: number }) =>
    (t.input * p.input +
      t.write * (share * p.cache_write_1h + (1 - share) * p.cache_write_5m) +
      t.read * p.cache_read +
      t.output * p.output) /
    1e6;
  if (s.modelUsage && Object.keys(s.modelUsage).length > 0) {
    return Object.entries(s.modelUsage).reduce(
      (sum, [id, m]) =>
        sum +
        usd(priceOf(m.canonicalModel ?? id), {
          input: m.inputTokens,
          write: m.cacheCreationInputTokens,
          read: m.cacheReadInputTokens,
          output: m.outputTokens,
        }),
      0,
    );
  }
  const u = s.usage;
  return usd(priceOf(s.model), {
    input: u.input_tokens,
    write: u.cache_creation_input_tokens,
    read: u.cache_read_input_tokens,
    output: u.output_tokens,
  });
}

export interface CostReport {
  sessions: number;
  usd: number;
  /** What the CLI reported, to check the recomputation against. */
  cliUsd: number;
  pages: number;
  perPage: number;
  validCitations: number;
  /** model-routing.md's metric: a cited claim, not a page, is the unit of value. */
  perValidCitation: number;
  prices: { source: string; checked: string };
}

export function costReport(
  sessions: readonly Session[],
  pages: number,
  validCitations: number,
): CostReport {
  const usd = sessions.reduce((s, x) => s + sessionCost(x), 0);
  return {
    sessions: sessions.length,
    usd,
    cliUsd: sessions.reduce((s, x) => s + (x.total_cost_usd ?? 0), 0),
    pages,
    perPage: pages ? usd / pages : NaN,
    validCitations,
    perValidCitation: validCitations ? usd / validCitations : NaN,
    prices: { source: PRICES_SOURCE, checked: PRICES_CHECKED },
  };
}
