import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DATA, DOCS, RESULTS } from "../lib/paths.ts";
import { splice, table } from "../lib/report-kit.ts";
import { auroc, fmtRate, percentile, rate } from "../lib/stats.ts";

const CARD = join(DOCS, "experiments", "t3-drift-triage.md");

export function reportT3Got(): void {
  const jf = join(RESULTS, "r-t3-got-jev.json");
  const lf = join(RESULTS, "r-t3-got-haiku+opus.json");
  if (!existsSync(jf) || !existsSync(lf)) return;
  const { items } = JSON.parse(readFileSync(join(DATA, "t3-got.json"), "utf8")) as {
    items: { touched: boolean; file_changed: boolean }[];
  };
  const rows: {
    id: string;
    split: string;
    arm: string;
    value: any;
    latency_ms: number;
    cost_usd: number;
  }[] = [
    ...JSON.parse(readFileSync(jf, "utf8")).rows,
    ...JSON.parse(readFileSync(lf, "utf8")).rows,
  ];
  const opus = rows.filter((r) => r.arm === "opus");
  const label = new Map(
    opus
      .filter((r) => r.value === "invalidated" || r.value === "valid")
      .map((r) => [r.id, r.value === "invalidated"]),
  );
  const untouched = opus.filter((r) => r.split === "untouched" && label.has(r.id));
  const touchedLabelled = opus.filter((r) => r.split !== "untouched" && label.has(r.id));
  const invalid = touchedLabelled.filter((r) => label.get(r.id)).length;

  const funnel = table(
    ["Step", "Citations still to re-verify", "Share of 683"],
    [
      ["accreta today: every page citing the revision", items.length, "100%"],
      [
        "per-file check: citations into a changed file",
        items.filter((i) => i.file_changed).length,
        `${((items.filter((i) => i.file_changed).length / items.length) * 100).toFixed(1)}%`,
      ],
      [
        "cited range intersected with diff hunks",
        items.filter((i) => i.touched).length,
        `${((items.filter((i) => i.touched).length / items.length) * 100).toFixed(1)}%`,
      ],
      [
        "of those, invalidated according to the annotator",
        invalid,
        `${((invalid / items.length) * 100).toFixed(1)}%`,
      ],
    ],
  );

  const arms = ["jev", "haiku"].map((arm) => {
    const rs = rows.filter((r) => r.arm === arm && label.has(r.id) && typeof r.value === "number");
    const p = rs.map((r) => r.value as number);
    const y = rs.map((r) => label.get(r.id)!);
    // Post-hoc: the lowest threshold that still flags every invalidated claim, and what it clears.
    const floor = Math.min(...rs.filter((r) => label.get(r.id)).map((r) => r.value as number));
    const valid = rs.filter((r) => !label.get(r.id));
    const lat = rs.map((r) => r.latency_ms).filter((x) => x > 0);
    const test = rs.filter((r) => r.split === "test");
    return [
      arm,
      rs.length,
      auroc(p, y).toFixed(3),
      `${auroc(
        test.map((r) => r.value as number),
        test.map((r) => label.get(r.id)!),
      ).toFixed(3)} (n=${test.length})`,
      floor.toFixed(2),
      fmtRate(rate(valid.filter((r) => (r.value as number) < floor).length, valid.length)),
      `${Math.round(percentile(lat, 0.5))} ms`,
      `$${((rs.reduce((s, r) => s + r.cost_usd, 0) / rs.length) * 1000).toFixed(3)}`,
    ];
  });

  splice(
    CARD,
    "t3-got",
    [
      "Labels are Claude Opus 5.5's, pending the maintainer's blind audit. They are to be read as the annotator's judgement, not as ground truth.",
      "",
      funnel,
      "",
      `**The free step.** In a seeded sample of untouched citations the annotator found ${fmtRate(rate(untouched.filter((r) => label.get(r.id)).length, untouched.length))} invalidated: the ones hunk intersection would have cleared wrongly.`,
      "",
      `**The decider on touched citations.** ${invalid} of ${touchedLabelled.length} labelled touched citations are invalidated, all of them in the test split. The calibration split holds none, so the pre-registered τ rule has nothing to calibrate on and degenerates to clearing nothing. The columns below are therefore **post hoc**: the lowest probability any invalidated claim received, and the share of valid claims below it, which is what a threshold at that point would clear.`,
      "",
      table(
        [
          "Arm",
          "Labelled items",
          "AUROC vs annotator, all touched",
          "AUROC, pre-registered test split",
          "Lowest p on an invalidated claim",
          "Valid claims below it (cleared)",
          "Latency p50",
          "Cost per 1,000",
        ],
        arms,
      ),
    ].join("\n"),
  );
}
