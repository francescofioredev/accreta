import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DOCS, RESULTS } from "../lib/paths.ts";
import { splice, table } from "../lib/report-kit.ts";
import { fmtRate, percentile, rate } from "../lib/stats.ts";
import { PROTOCOL } from "./t2-scifact.ts";

const CARD = join(DOCS, "experiments", "t2-citation-support.md");
const LABELS = ["supports", "contradicts", "says_nothing"] as const;

interface Row {
  id: string;
  split: string;
  label: string;
  arm: string;
  choice: string | null;
  probabilities: Record<string, number> | null;
  latency_ms: number;
  input_tokens: number;
  cost_usd: number;
  error?: string;
}

const pSupports = (r: Row) => r.probabilities?.supports ?? (r.choice === "supports" ? 1 : 0);

function tauFrom(cal: Row[]): number {
  const neg = cal.filter((r) => r.label !== "supports");
  for (const t of PROTOCOL.tau_grid)
    if (
      neg.filter((r) => pSupports(r) >= t).length / neg.length <=
      PROTOCOL.calibration_max_false_support
    )
      return t;
  return 1;
}

function macroF1(rows: Row[]): number {
  return (
    LABELS.reduce((s, l) => {
      const tp = rows.filter((r) => r.choice === l && r.label === l).length;
      const fp = rows.filter((r) => r.choice === l && r.label !== l).length;
      const fn = rows.filter((r) => r.choice !== l && r.label === l).length;
      return s + (tp ? (2 * tp) / (2 * tp + fp + fn) : 0);
    }, 0) / LABELS.length
  );
}

export function reportT2(): void {
  const summary: (string | number)[][] = [];
  const confusion: (string | number)[][] = [];
  for (const arm of ["jev", "haiku"]) {
    const f = join(RESULTS, `r-t2-scifact-${arm}.json`);
    if (!existsSync(f)) continue;
    const rows: Row[] = JSON.parse(readFileSync(f, "utf8")).rows.filter(
      (r: Row) => !r.error && r.choice,
    );
    const test = rows.filter((r) => r.split === "test");
    const tau = tauFrom(rows.filter((r) => r.split === "calibration"));
    const neg = test.filter((r) => r.label !== "supports");
    const pos = test.filter((r) => r.label === "supports");
    const lat = rows.map((r) => r.latency_ms).filter((x) => x > 0);
    summary.push([
      arm,
      rate(test.filter((r) => r.choice === r.label).length, test.length).rate.toFixed(3),
      macroF1(test).toFixed(3),
      fmtRate(rate(neg.filter((r) => r.choice === "supports").length, neg.length)),
      tau.toFixed(2),
      fmtRate(rate(neg.filter((r) => pSupports(r) >= tau).length, neg.length)),
      fmtRate(rate(pos.filter((r) => pSupports(r) >= tau).length, pos.length)),
      `${Math.round(percentile(lat, 0.5))} / ${Math.round(percentile(lat, 0.95))} ms`,
      `$${((rows.reduce((s, r) => s + r.cost_usd, 0) / rows.length) * 1000).toFixed(3)}`,
    ]);
    for (const gold of LABELS)
      confusion.push([
        arm,
        gold,
        ...LABELS.map((p) => test.filter((r) => r.label === gold && r.choice === p).length),
      ]);
  }
  if (!summary.length) return;
  splice(
    CARD,
    "t2-scifact",
    [
      "SciFact dev, 340 claim–abstract pairs (138 supports, 71 contradicts, 131 says nothing). τ fixed on 300 pairs from SciFact train.",
      "",
      table(
        [
          "Arm",
          "Accuracy",
          "Macro F1",
          "False “supports”, argmax",
          "τ",
          "False “supports” at τ",
          "Supports accepted at τ",
          "Latency p50 / p95",
          "Cost per 1,000",
        ],
        summary,
      ),
      "",
      "Confusion, test (rows are the gold label, columns the prediction):",
      "",
      table(["Arm", "Gold", ...LABELS], confusion),
    ].join("\n"),
  );
}
