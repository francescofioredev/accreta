import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DOCS, RESULTS } from "../lib/paths.ts";
import { lineChart, splice, table } from "../lib/report-kit.ts";
import { auroc, brier, ece, fmtRate, percentile, pct, rate } from "../lib/stats.ts";
import { PROTOCOL } from "./t3-errata.ts";
import type { Row } from "./run-t3.ts";

const CARD = join(DOCS, "experiments", "t3-drift-triage.md");
const ARMS = ["whitespace-only", "normative-regex", "haiku", "jev"];
const COLORS: Record<string, string> = {
  jev: "#2563eb",
  haiku: "#d97706",
  "whitespace-only": "#6b7280",
  "normative-regex": "#059669",
};

export function loadRows(prefix: string): Row[] {
  if (!existsSync(RESULTS)) return [];
  return readdirSync(RESULTS)
    .filter((f) => f.startsWith(prefix) && f.endsWith(".json"))
    .flatMap((f) => JSON.parse(readFileSync(join(RESULTS, f), "utf8")).rows as Row[]);
}

const cleared = (rows: Row[], tau: number) => rows.filter((r) => r.p !== null && r.p < tau);

/** The pre-registered rule: the largest tau whose calibration false-"still valid" rate is within the margin. */
export function chooseTau(calibration: Row[]): number {
  const technical = calibration.filter((r) => r.label === "technical" && r.p !== null);
  let best = 0;
  for (const tau of PROTOCOL.tau_grid) {
    if (
      cleared(technical, tau).length / technical.length <=
      PROTOCOL.calibration_max_false_still_valid
    )
      best = tau;
  }
  return best;
}

export function reportT3(): void {
  const all = loadRows("r-t3-").filter((r) => r.sample === 0);
  const present = ARMS.filter((a) => all.some((r) => r.arm === a && r.p !== null));
  const summary: (string | number)[][] = [];
  const confusion: (string | number)[][] = [];
  const series: { name: string; points: [number, number][]; color: string }[] = [];
  const marks: { name: string; x: number; y: number; color: string }[] = [];

  for (const arm of present) {
    const rows = all.filter((r) => r.arm === arm);
    const ok = rows.filter((r) => r.p !== null);
    const tau = chooseTau(ok.filter((r) => r.split === "calibration"));
    const test = ok.filter((r) => r.split === "test");
    const tech = test.filter((r) => r.label === "technical");
    const edit = test.filter((r) => r.label === "editorial");
    const fsv = rate(cleared(tech, tau).length, tech.length);
    const clr = rate(cleared(edit, tau).length, edit.length);
    const p = test.map((r) => r.p!);
    const y = test.map((r) => r.label === "technical");
    const probabilistic = arm === "jev" || arm === "haiku";
    const lat = rows.map((r) => r.latency_ms).filter((x) => x > 0);
    const cost = rows.reduce((s, r) => s + r.cost_usd, 0) / rows.length;
    summary.push([
      arm,
      tau.toFixed(2),
      fmtRate(fsv),
      fmtRate(clr),
      auroc(p, y).toFixed(3),
      probabilistic ? brier(p, y).toFixed(3) : "—",
      probabilistic ? ece(p, y).toFixed(3) : "—",
      lat.length
        ? `${Math.round(percentile(lat, 0.5))} / ${Math.round(percentile(lat, 0.95))} ms`
        : "—",
      probabilistic ? `$${(cost * 1000).toFixed(3)}` : "$0",
      rows.length - ok.length,
    ]);
    confusion.push([
      arm,
      tech.length - cleared(tech, tau).length,
      cleared(tech, tau).length,
      edit.length - cleared(edit, tau).length,
      cleared(edit, tau).length,
    ]);
    if (probabilistic) {
      series.push({
        name: arm,
        color: COLORS[arm]!,
        points: [0, ...PROTOCOL.tau_grid, 1.0001].map(
          (t) =>
            [cleared(tech, t).length / tech.length, cleared(edit, t).length / edit.length] as [
              number,
              number,
            ],
        ),
      });
    }
    marks.push({ name: `${arm} at τ`, x: fsv.rate, y: clr.rate, color: COLORS[arm]! });
  }
  if (!present.length) return;

  const repeat = loadRows("r-t3-").filter((r) => r.arm === "jev" && r.sample === 1 && r.p !== null);
  const first = new Map(all.filter((r) => r.arm === "jev").map((r) => [r.id, r.p]));
  const deltas = repeat
    .map((r) => Math.abs(r.p! - (first.get(r.id) ?? NaN)))
    .filter((d) => !Number.isNaN(d));
  const tauJev = chooseTau(
    all.filter((r) => r.arm === "jev" && r.split === "calibration" && r.p !== null),
  );
  const flips = repeat.filter((r) => r.p! < tauJev !== (first.get(r.id) ?? 1) < tauJev).length;

  const body = [
    "Test split: 400 technical and 400 editorial errata. τ was fixed on the calibration split by the pre-registered rule.",
    "",
    table(
      [
        "Arm",
        "τ",
        "False “still valid” (technical cleared)",
        "Editorial cleared (re-reading saved)",
        "AUROC",
        "Brier",
        "ECE",
        "Latency p50 / p95",
        "Cost per 1,000",
        "Errors",
      ],
      summary,
    ),
    "",
    "Confusion matrix at τ, test split:",
    "",
    table(
      [
        "Arm",
        "Technical → flagged",
        "Technical → cleared ✗",
        "Editorial → flagged",
        "Editorial → cleared",
      ],
      confusion,
    ),
    "",
    deltas.length
      ? `Repeatability: Jev asked twice on ${deltas.length} test items. Median |Δp| ${percentile(deltas, 0.5).toFixed(3)}, max ${Math.max(...deltas).toFixed(3)}; the decision at τ flipped on ${flips} of ${deltas.length}.`
      : "",
    "",
    "![Trade-off between the gated error and the re-reading saved, test split](t3-tradeoff.svg)",
  ].join("\n");
  splice(CARD, "t3-r", body);
  writeFileSync(
    join(DOCS, "experiments", "t3-tradeoff.svg"),
    lineChart({
      title: "T3 tier R: every threshold, test split",
      xLabel: "False “still valid” (technical errata cleared)",
      yLabel: "Editorial errata cleared",
      series,
      marks,
    }),
  );
}
