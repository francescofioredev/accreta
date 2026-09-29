#!/usr/bin/env bun
/**
 * T1, tier C: the leaf declarations of got's source/ at v13.0.0, labelled by whether the tier C
 * ingest cited a line inside them (any run, and at least two of three).
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA } from "../lib/paths.ts";
import { shuffle } from "../lib/rng.ts";
import { units as readingUnits } from "../lib/ts-decls.ts";
import { FROM_TAG, RUNS_DIR } from "../tasks/ingest-got.ts";

export const RULE = { min_lines: 3, calibration_share: 1 / 3, seed: 20261008 } as const;
const REPO_DIR = join(RUNS_DIR, "run1", "repo");

if (import.meta.main) {
  const { items: cites } = JSON.parse(readFileSync(join(DATA, "t3-got.json"), "utf8")) as {
    items: { run: number; path: string; start: number; end: number }[];
  };
  const files = execFileSync("git", [
    "-C",
    REPO_DIR,
    "ls-tree",
    "-r",
    "--name-only",
    FROM_TAG,
    "source/",
  ])
    .toString()
    .split("\n")
    .filter((f) => f.endsWith(".ts"));
  const calibration = new Set(
    shuffle(files, RULE.seed).slice(0, Math.round(files.length * RULE.calibration_share)),
  );
  const units = files.flatMap((path) => {
    const text = execFileSync("git", ["-C", REPO_DIR, "show", `${FROM_TAG}:${path}`]).toString();
    return readingUnits(text)
      .filter((d) => d.end - d.start + 1 >= RULE.min_lines)
      .map((d) => {
        const runs = new Set(
          cites
            .filter((c) => c.path === path && c.start <= d.end && c.end >= d.start)
            .map((c) => c.run),
        );
        return {
          id: `${path}#${d.path}@${d.start}`,
          path,
          decl: d.path,
          start: d.start,
          end: d.end,
          chars: d.text.length,
          exported: d.exported,
          split: calibration.has(path) ? "calibration" : "test",
          runs_citing: runs.size,
          label: runs.size >= 1,
          label_majority: runs.size >= 2,
        };
      });
  });
  writeFileSync(join(DATA, "t1-got.json"), JSON.stringify({ rule: RULE, units }) + "\n");
  const s = (split: string) => {
    const u = units.filter((x) => x.split === split);
    return {
      files: new Set(u.map((x) => x.path)).size,
      units: u.length,
      cited: u.filter((x) => x.label).length,
      chars: u.reduce((a, x) => a + x.chars, 0),
      cited_chars: u.filter((x) => x.label).reduce((a, x) => a + x.chars, 0),
    };
  };
  console.log({ calibration: s("calibration"), test: s("test") });
}
