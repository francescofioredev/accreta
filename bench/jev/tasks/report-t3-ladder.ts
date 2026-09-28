import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DOCS, RESULTS } from "../lib/paths.ts";
import { splice, table } from "../lib/report-kit.ts";
import { auroc, ece, fmtRate, percentile, rate } from "../lib/stats.ts";
import { PROTOCOL } from "./t3-errata.ts";
import type { LadderRow } from "./run-t3-ladder.ts";

const CARD = join(DOCS, "experiments", "t3-drift-triage.md");
const load = (name: string): { rows: LadderRow[]; selected?: string; level?: string } | null => {
  const f = join(RESULTS, `r-t3-ladder-${name}.json`);
  return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : null;
};

const ok = (rows: LadderRow[]) => rows.filter((r) => r.p !== null && !r.error);
const isTech = (r: LadderRow) => r.label === "technical";

/** The original τ rule, applied to whichever rows are the calibration set. */
function tauFrom(calibration: LadderRow[]): number {
  const tech = calibration.filter(isTech);
  let best = 0;
  for (const t of PROTOCOL.tau_grid)
    if (
      tech.filter((r) => r.p! < t).length / tech.length <=
      PROTOCOL.calibration_max_false_still_valid
    )
      best = t;
  return best;
}

function scored(rows: LadderRow[], tau: number) {
  const tech = rows.filter(isTech);
  const edit = rows.filter((r) => !isTech(r));
  return {
    auc: auroc(
      rows.map((r) => r.p!),
      rows.map(isTech),
    ),
    ece: ece(
      rows.map((r) => r.p!),
      rows.map(isTech),
    ),
    fsv: rate(tech.filter((r) => r.p! < tau).length, tech.length),
    cleared: rate(edit.filter((r) => r.p! < tau).length, edit.length),
  };
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

export function reportT3Ladder(): void {
  const jev = load("jev");
  if (!jev) return;
  const haiku = load("haiku");
  const all = [...ok(jev.rows), ...(haiku ? ok(haiku.rows) : [])];
  const configs = [...new Set(all.map((r) => `${r.arm}|${r.config}`))];
  const lines = configs.map((key) => {
    const [arm, config] = key.split("|") as [string, string];
    const rows = all.filter((r) => r.arm === arm && r.config === config);
    const cal = rows.filter((r) => r.split === "calibration");
    const test = rows.filter((r) => r.split === "test");
    const tau = tauFrom(cal);
    const s = scored(test, tau);
    const selected = arm === "jev" && config === jev.selected;
    return [
      `${arm} ${config}${selected ? " **(selected)**" : ""}`,
      auroc(
        cal.map((r) => r.p!),
        cal.map(isTech),
      ).toFixed(3),
      s.auc.toFixed(3),
      tau.toFixed(2),
      fmtRate(s.fsv),
      fmtRate(s.cleared),
      s.ece.toFixed(3),
      Math.round(mean(rows.map((r) => r.input_tokens))),
      `$${(mean(rows.map((r) => r.cost_usd)) * 1000).toFixed(3)}`,
    ];
  });
  splice(
    CARD,
    "t3-ladder",
    [
      `Selected on calibration AUROC: **${jev.selected}**. Test figures for every other configuration are exploratory.`,
      "",
      table(
        [
          "Arm and configuration",
          "AUROC, calibration",
          "AUROC, test",
          "τ",
          "False “still valid”, test",
          "Editorial cleared, test",
          "ECE, test",
          "Input tokens",
          "Cost per 1,000",
        ],
        lines,
      ),
    ].join("\n"),
  );

  const l3 = load("l3");
  if (l3) {
    const body = ["jev", "haiku"]
      .filter((a) => l3.rows.some((r) => r.arm === a))
      .map((arm) => {
        const rows = ok(l3.rows).filter((r) => r.arm === arm);
        const tau = tauFrom(rows.filter((r) => r.split === "calibration"));
        const s = scored(
          rows.filter((r) => r.split === "test"),
          tau,
        );
        return [
          arm,
          tau.toFixed(2),
          s.auc.toFixed(3),
          fmtRate(s.fsv),
          fmtRate(s.cleared),
          s.ece.toFixed(3),
          Math.round(mean(rows.map((r) => r.input_tokens))),
        ];
      });
    splice(
      CARD,
      "t3-l3",
      [
        "Claim-conditioned question. There are 25 calibration items per class, so τ rests on a small set: at 2% of 25, no technical item may be cleared.",
        "",
        table(
          [
            "Arm",
            "τ",
            "AUROC, test",
            "False “still valid”, test",
            "Editorial cleared, test",
            "ECE",
            "Input tokens",
          ],
          body,
        ),
      ].join("\n"),
    );
  }

  const batch = load("batch");
  if (batch) {
    const selectedRows = ok(jev.rows).filter((r) => r.config === jev.selected);
    const tau = tauFrom(selectedRows.filter((r) => r.split === "calibration"));
    const ks = [...new Set(batch.rows.map((r) => r.batch_k))].sort((a, b) => a - b);
    const body = ks.map((k) => {
      const rows = batch.rows.filter((r) => r.batch_k === k);
      const good = ok(rows);
      const s = scored(good, tau);
      const perCall = rows.map((r) => r.latency_ms).filter((x) => x > 0);
      return [
        k,
        s.auc.toFixed(3),
        fmtRate(s.fsv),
        fmtRate(s.cleared),
        Math.round(mean(good.map((r) => r.input_tokens))),
        `$${(mean(good.map((r) => r.cost_usd)) * 1000).toFixed(4)}`,
        `${Math.round(percentile(perCall, 0.5))} / ${Math.round(percentile(perCall, 0.95))} ms`,
        `${Math.round(percentile(perCall, 0.5) / k)} ms`,
        rows.length - good.length,
      ];
    });
    splice(
      CARD,
      "t3-batch",
      [
        `Level ${batch.level}, packed: one shared rubric, one \`noul\` per item. τ = ${tau.toFixed(2)}, from the selected unpacked configuration's calibration split. Test split only, 800 items per K.`,
        "",
        table(
          [
            "K per call",
            "AUROC",
            "False “still valid”",
            "Editorial cleared",
            "Input tokens per decision",
            "Cost per 1,000",
            "Latency per call p50 / p95",
            "Latency per decision p50",
            "Missing answers",
          ],
          body,
        ),
      ].join("\n"),
    );
  }
}
