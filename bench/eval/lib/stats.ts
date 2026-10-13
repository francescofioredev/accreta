import { clopperPearson, rate, type Rate } from "../../jev/lib/stats.ts";

export { clopperPearson, rate, type Rate };

const Z95 = 1.959963984540054;

/** Wilson score interval for k successes in n, at 95% by default. */
export function wilson(k: number, n: number, z = Z95): [number, number] {
  if (n === 0) return [0, 1];
  const p = k / n;
  const denom = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return [Math.max(0, centre - half), Math.min(1, centre + half)];
}

/** P(X <= k) for X ~ Binomial(n, 1/2), summed exactly in log space. */
function halfBinomCdf(k: number, n: number): number {
  if (k < 0) return 0;
  if (k >= n) return 1;
  let logC = 0;
  let s = 0;
  for (let i = 0; i <= k; i++) {
    if (i > 0) logC += Math.log(n - i + 1) - Math.log(i);
    s += Math.exp(logC - n * Math.LN2);
  }
  return Math.min(1, s);
}

export interface McNemar {
  /** Pairs where only arm A was right. */
  b: number;
  /** Pairs where only arm B was right. */
  c: number;
  /** Exact two-sided p: twice the smaller tail of Binomial(b + c, 1/2), capped at 1. */
  pTwoSided: number;
  /** Exact one-sided p for "A beats B": P(X >= b). */
  pAGreater: number;
}

/** Exact McNemar test on paired binary outcomes: only the discordant pairs carry information. */
export function mcnemarExact(b: number, c: number): McNemar {
  const n = b + c;
  if (n === 0) return { b, c, pTwoSided: 1, pAGreater: 1 };
  return {
    b,
    c,
    pTwoSided: Math.min(1, 2 * halfBinomCdf(Math.min(b, c), n)),
    pAGreater: 1 - halfBinomCdf(b - 1, n),
  };
}

/** McNemar from two aligned arrays of per-item correctness. */
export function mcnemarPaired(a: readonly boolean[], bArm: readonly boolean[]): McNemar {
  if (a.length !== bArm.length) throw new Error("paired arms must have the same items");
  let b = 0;
  let c = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] && !bArm[i]) b++;
    else if (!a[i] && bArm[i]) c++;
  }
  return mcnemarExact(b, c);
}

/**
 * Fewest positives for which `misses` misses still leave the two-sided 95% Clopper–Pearson lower
 * bound at or above `target`. The review's figure: recall 0.9 at zero misses needs 36.
 */
export function positivesNeeded(target: number, misses = 0, alpha = 0.05, cap = 100_000): number {
  for (let n = misses + 1; n <= cap; n++) {
    if (clopperPearson(n - misses, n, alpha)[0] >= target) return n;
  }
  return Infinity;
}

export type Sided = "one" | "two";

const pOf = (m: McNemar, sided: Sided) => (sided === "one" ? m.pAGreater : m.pTwoSided);

/** Smallest b of b + c = `discordant` for which the exact McNemar p is below alpha. */
export function mcnemarThreshold(
  discordant: number,
  alpha = 0.05,
  sided: Sided = "two",
): number | null {
  for (let b = Math.ceil(discordant / 2); b <= discordant; b++) {
    if (pOf(mcnemarExact(b, discordant - b), sided) < alpha) return b;
  }
  return null;
}

/** log of the Binomial(n, p) pmf at k. */
function logBinom(k: number, n: number, p: number): number {
  let logC = 0;
  for (let i = 1; i <= k; i++) logC += Math.log(n - i + 1) - Math.log(i);
  const tail = (x: number, w: number) => (w === 0 ? 0 : w * Math.log(x));
  return logC + tail(p, k) + tail(1 - p, n - k);
}

/**
 * Exact power of the McNemar test on n pairs, when a pair is right only in arm A with
 * probability `pA` and only in arm B with probability `pB`.
 */
export function mcnemarPower(
  n: number,
  pA: number,
  pB: number,
  alpha = 0.05,
  sided: Sided = "one",
) {
  const pd = pA + pB;
  let power = 0;
  for (let d = 1; d <= n; d++) {
    const t = mcnemarThreshold(d, alpha, sided);
    if (t === null) continue;
    const pDiscordant = Math.exp(logBinom(d, n, pd));
    for (let b = t; b <= d; b++) power += pDiscordant * Math.exp(logBinom(b, d, pA / pd));
  }
  return power;
}

export interface Interval {
  k: number;
  n: number;
  rate: number;
  wilson: [number, number];
  clopperPearson: [number, number];
}

export const interval = (k: number, n: number): Interval => ({
  k,
  n,
  rate: n ? k / n : NaN,
  wilson: wilson(k, n),
  clopperPearson: clopperPearson(k, n),
});

/** The three-way verdict the protocol pre-registers for a rate against a floor. */
export type GateVerdict = "met" | "not shown" | "failed" | "no data";

export function gate(r: Rate, floor: number): GateVerdict {
  if (r.n === 0) return "no data";
  if (r.ci[0] >= floor) return "met";
  return r.rate >= floor ? "not shown" : "failed";
}

export interface Summary {
  n: number;
  mean: number;
  median: number;
  max: number;
}

export function summary(xs: readonly number[]): Summary {
  if (xs.length === 0) return { n: 0, mean: NaN, median: NaN, max: NaN };
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length / 2;
  const median = s.length % 2 ? s[Math.floor(mid)]! : (s[mid - 1]! + s[mid]!) / 2;
  return { n: s.length, mean: s.reduce((a, b) => a + b, 0) / s.length, median, max: s.at(-1)! };
}
