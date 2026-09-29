function binomCdf(k: number, n: number, p: number): number {
  if (k < 0) return 0;
  if (k >= n) return 1;
  // Terms by recurrence in log space: O(k), where recomputing each coefficient was O(k^2).
  let logTerm = n * Math.log1p(-p);
  let s = Math.exp(logTerm);
  const ratio = Math.log(p) - Math.log1p(-p);
  for (let i = 1; i <= k; i++) {
    logTerm += Math.log(n - i + 1) - Math.log(i) + ratio;
    s += Math.exp(logTerm);
  }
  return Math.min(1, s);
}

function bisect(f: (p: number) => number, target: number, increasing: boolean): number {
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (f(mid) < target === increasing) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/** Exact (Clopper–Pearson) 95% interval for k successes in n. */
export function clopperPearson(k: number, n: number, alpha = 0.05): [number, number] {
  if (n === 0) return [0, 1];
  const lower = k === 0 ? 0 : bisect((p) => 1 - binomCdf(k - 1, n, p), alpha / 2, true);
  const upper = k === n ? 1 : bisect((p) => binomCdf(k, n, p), alpha / 2, false);
  return [lower, upper];
}

export interface Rate {
  k: number;
  n: number;
  rate: number;
  ci: [number, number];
}

export const rate = (k: number, n: number): Rate => ({
  k,
  n,
  rate: n ? k / n : NaN,
  ci: clopperPearson(k, n),
});

export function percentile(xs: number[], q: number): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))]!;
}

export function cohenKappa(a: string[], b: string[]): number {
  const n = a.length;
  const labels = [...new Set([...a, ...b])];
  const po = a.filter((x, i) => x === b[i]).length / n;
  const pe = labels.reduce(
    (s, l) => s + (a.filter((x) => x === l).length / n) * (b.filter((x) => x === l).length / n),
    0,
  );
  return pe === 1 ? 1 : (po - pe) / (1 - pe);
}

/** Area under the ROC curve: P(score of a random positive > score of a random negative). */
export function auroc(scores: number[], labels: boolean[]): number {
  const pos = scores.filter((_, i) => labels[i]);
  const neg = scores.filter((_, i) => !labels[i]);
  let wins = 0;
  for (const p of pos) for (const q of neg) wins += p > q ? 1 : p === q ? 0.5 : 0;
  return wins / (pos.length * neg.length);
}

export const brier = (p: number[], y: boolean[]) =>
  p.reduce((s, x, i) => s + (x - (y[i] ? 1 : 0)) ** 2, 0) / p.length;

/** Expected calibration error over equal-width bins. */
export function ece(p: number[], y: boolean[], bins = 10): number {
  let total = 0;
  for (let b = 0; b < bins; b++) {
    const idx = p
      .map((x, i) => i)
      .filter((i) =>
        b === bins - 1 ? p[i]! >= b / bins : p[i]! >= b / bins && p[i]! < (b + 1) / bins,
      );
    if (!idx.length) continue;
    const conf = idx.reduce((s, i) => s + p[i]!, 0) / idx.length;
    const acc = idx.filter((i) => y[i]).length / idx.length;
    total += (idx.length / p.length) * Math.abs(conf - acc);
  }
  return total;
}

export const pct = (x: number, digits = 1) =>
  Number.isNaN(x) ? "—" : `${(x * 100).toFixed(digits)}%`;
export const fmtRate = (r: Rate) =>
  `${pct(r.rate)} (${r.k}/${r.n}; 95% CI ${pct(r.ci[0])}–${pct(r.ci[1])})`;
