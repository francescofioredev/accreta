import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DOCS, RESULTS } from "../lib/paths.ts";
import { lineChart, splice, table } from "../lib/report-kit.ts";
import { auroc, fmtRate, pct, percentile, rate } from "../lib/stats.ts";
import { PROTOCOL } from "./t1-triage.ts";
import type { T1Row } from "./run-t1.ts";

const CARD = join(DOCS, "experiments", "t1-ingest-triage.md");
const COLORS = ["#2563eb", "#7c3aed", "#0891b2", "#d97706", "#059669", "#6b7280", "#db2777"];

/** Largest tau keeping recall of cited sections at or above the floor. */
function tauFrom(rows: T1Row[]): number {
  const pos = rows
    .filter((r) => r.label)
    .map((r) => r.p!)
    .sort((a, b) => a - b);
  const allowedMisses = Math.floor(pos.length * (1 - PROTOCOL.calibration_min_recall));
  return pos[allowedMisses] ?? 0;
}

function at(rows: T1Row[], tau: number) {
  const pos = rows.filter((r) => r.label);
  const kept = rows.filter((r) => r.p! >= tau);
  const totalChars = rows.reduce((s, r) => s + r.chars, 0);
  return {
    recall: rate(pos.filter((r) => r.p! >= tau).length, pos.length),
    skippedSections: rate(rows.length - kept.length, rows.length),
    skippedChars: 1 - kept.reduce((s, r) => s + r.chars, 0) / totalChars,
  };
}

export function reportT1(): void {
  const f = join(RESULTS, "r-t1-jev.json");
  if (!existsSync(f)) return;
  const jev = JSON.parse(readFileSync(f, "utf8"));
  const hf = join(RESULTS, "r-t1-haiku.json");
  const rows: T1Row[] = [
    ...jev.rows,
    ...(existsSync(hf) ? JSON.parse(readFileSync(hf, "utf8")).rows : []),
  ].filter((r: T1Row) => r.p !== null && !r.error);
  const keys = [...new Set(rows.map((r) => `${r.arm}|${r.config}`))];
  const series: { name: string; points: [number, number][]; color: string }[] = [];
  const lines = keys.map((key, k) => {
    const [arm, config] = key.split("|") as [string, string];
    const rs = rows.filter((r) => r.arm === arm && r.config === config);
    const cal = rs.filter((r) => r.split === "calibration");
    const test = rs.filter((r) => r.split === "test");
    const tau = tauFrom(cal);
    const s = at(test, tau);
    const name = `${arm}${config !== "-" ? ` ${config}` : ""}`;
    const thresholds = [...new Set(test.map((r) => r.p!))].sort((a, b) => a - b);
    const step = Math.max(1, Math.floor(thresholds.length / 200));
    series.push({
      name,
      color: COLORS[k % COLORS.length]!,
      points: thresholds
        .filter((_, i) => i % step === 0)
        .map((t) => {
          const x = at(test, t);
          return [x.recall.rate, x.skippedChars] as [number, number];
        }),
    });
    const lat = rs.map((r) => r.latency_ms).filter((x) => x > 0);
    return [
      `${name}${arm === "jev" && config === jev.selected ? " **(selected)**" : ""}`,
      auroc(
        cal.map((r) => r.p!),
        cal.map((r) => r.label),
      ).toFixed(3),
      auroc(
        test.map((r) => r.p!),
        test.map((r) => r.label),
      ).toFixed(3),
      fmtRate(s.recall),
      pct(s.skippedSections.rate),
      pct(s.skippedChars),
      lat.length ? `${Math.round(percentile(lat, 0.5))} ms` : "—",
      rs[0]!.questions_per_call,
      arm === "jev" || arm === "haiku"
        ? `$${((rs.reduce((a, r) => a + r.cost_usd, 0) / rs.length) * 1000).toFixed(3)}`
        : "$0",
    ];
  });
  splice(
    CARD,
    "t1-r",
    [
      `Test: 15 RFCs, 2,267 sections, 826 cited by another RFC. τ fixed on the 5 calibration RFCs for recall ≥ ${PROTOCOL.calibration_min_recall}. Selected level: **${jev.selected}**. Haiku's test figures come from a seeded sample when it runs per section.`,
      "",
      table(
        [
          "Arm",
          "AUROC, calibration",
          "AUROC, test",
          "Recall of cited sections at τ, test",
          "Sections skipped",
          "Characters skipped (reading saved)",
          "Latency p50 per call",
          "Questions per call",
          "Cost per 1,000 sections",
        ],
        lines,
      ),
      "",
      "![Recall of cited sections against reading skipped, every threshold, test RFCs](t1-tradeoff.svg)",
    ].join("\n"),
  );
  writeFileSync(
    join(DOCS, "experiments", "t1-tradeoff.svg"),
    lineChart({
      title: "T1 tier R: reading skipped vs recall, test RFCs",
      xLabel: "Recall of sections other RFCs cite",
      yLabel: "Characters skipped",
      series,
    }),
  );
}
