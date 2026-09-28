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

function chartPoint(rows: T1Row[], tau: number): [number, number] {
  const pos = rows.filter((r) => r.label);
  const total = rows.reduce((s, r) => s + r.chars, 0);
  const kept = rows.filter((r) => r.p! >= tau).reduce((s, r) => s + r.chars, 0);
  return [pos.filter((r) => r.p! >= tau).length / pos.length, 1 - kept / total];
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
  render(
    rows,
    jev.selected,
    "t1-r",
    "t1-tradeoff.svg",
    "T1 tier R: reading skipped vs recall, test RFCs",
    `Test: 15 RFCs, 2,267 sections, 826 cited by another RFC. τ fixed on the 5 calibration RFCs for recall ≥ ${PROTOCOL.calibration_min_recall}. Selected level: **${jev.selected}**. Haiku's test figures come from a seeded sample when it runs per section.`,
  );
}

export function reportT1Got(): void {
  const f = join(RESULTS, "r-t1-got.json");
  if (!existsSync(f)) return;
  const d = JSON.parse(readFileSync(f, "utf8"));
  render(
    d.rows.filter((r: T1Row) => r.p !== null && !r.error),
    d.selected,
    "t1-c",
    "t1-tradeoff-got.svg",
    "T1 tier C: reading skipped vs recall, got test files",
    `Test: 14 files of got v13.0.0, 188 declarations, 86 cited by the tier C ingest (79% of the characters). τ fixed on 7 calibration files for recall ≥ ${PROTOCOL.calibration_min_recall}. Selected level: **${d.selected}**.`,
  );
}

function render(
  rows: T1Row[],
  selected: string,
  marker: string,
  svg: string,
  chartTitle: string,
  intro: string,
): void {
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
      points: thresholds.filter((_, i) => i % step === 0).map((t) => chartPoint(test, t)),
    });
    const lat = rs.map((r) => r.latency_ms).filter((x) => x > 0);
    return [
      `${name}${arm === "jev" && config === selected ? " **(selected)**" : ""}`,
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
    marker,
    [
      intro,
      "",
      table(
        [
          "Arm",
          "AUROC, calibration",
          "AUROC, test",
          "Recall of cited units at τ, test",
          "Units skipped",
          "Characters skipped (reading saved)",
          "Latency p50 per call",
          "Questions per call",
          "Cost per 1,000 units",
        ],
        lines,
      ),
      "",
      `![Recall against reading skipped, every threshold](${svg})`,
    ].join("\n"),
  );
  writeFileSync(
    join(DOCS, "experiments", svg),
    lineChart({
      title: chartTitle,
      xLabel: "Recall of cited units",
      yLabel: "Characters skipped",
      series,
    }),
  );
}

// Opus 5.5 list prices per million tokens, checked on 2026-09-28 at platform.claude.com/docs/en/about-claude/pricing.
// Claude Code writes the 1-hour cache, which is why the CLI's reported cost matches the $8 write rate.
const OPUS_55 = { input: 4, cache_write_1h: 8, cache_read: 0.2, output: 20 } as const;

export function reportIngestCost(): void {
  const sessions = ["r-a-ingest.json", "r-c-ingest.json"].flatMap((f) =>
    existsSync(join(RESULTS, f)) ? JSON.parse(readFileSync(join(RESULTS, f), "utf8")).sessions : [],
  );
  if (!sessions.length) return;
  const lines = sessions.map((s: any) => {
    const u = s.usage;
    const parts = {
      write: (u.cache_creation_input_tokens * OPUS_55.cache_write_1h) / 1e6,
      read: (u.cache_read_input_tokens * OPUS_55.cache_read) / 1e6,
      out: (u.output_tokens * OPUS_55.output) / 1e6,
      input: (u.input_tokens * OPUS_55.input) / 1e6,
    };
    const total = parts.write + parts.read + parts.out + parts.input;
    const share = (x: number) => `${((x / total) * 100).toFixed(0)}%`;
    return [
      s.rfc ?? "got source/",
      s.run,
      s.num_turns,
      u.cache_creation_input_tokens,
      u.cache_read_input_tokens,
      u.output_tokens,
      `$${total.toFixed(2)}`,
      `$${s.total_cost_usd.toFixed(2)}`,
      share(parts.write),
      share(parts.read),
      share(parts.out),
    ];
  });
  splice(
    CARD,
    "t1-cost",
    [
      "Every baseline ingest session, Claude Opus 5.5 through Claude Code. Priced at list rates checked on 2026-09-28; the recomputed total matches the CLI's own report.",
      "",
      table(
        [
          "Source",
          "Run",
          "Turns",
          "Cache written",
          "Cache read",
          "Output",
          "Cost, recomputed",
          "Cost, CLI",
          "Share: cache writes",
          "Share: cache reads",
          "Share: output",
        ],
        lines,
      ),
    ].join("\n"),
  );
}
