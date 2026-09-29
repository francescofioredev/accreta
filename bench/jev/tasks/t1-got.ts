/**
 * T1, tier C: before an agent reads got's source, can a decider pick the declarations worth reading?
 * Units and labels in data/t1-got.json. Pre-registered before any model sees them.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DATA } from "../lib/paths.ts";
import type { Questions } from "../lib/questions.ts";
import { FROM_TAG, RUNS_DIR } from "./ingest-got.ts";

export type Level = "U0" | "U1" | "P";
export const LEVELS: Level[] = ["U0", "U1", "P"];
const INSTRUCTIONS =
  "Would a documentation page about this library need to cite this piece of code specifically, because it defines a " +
  "public API, an option and its default, an error, or a behaviour that users or other modules depend on? Private " +
  "plumbing, type re-exports and code whose name and signature already say everything are not cited this way.";
export const QUESTIONS: Questions = { cite_worthy: { type: "noul", instructions: INSTRUCTIONS } };
export const PROTOCOL = {
  calibration_min_recall: 0.95,
  packed_max_chars: 60000,
  selection: "max AUROC on calibration; ties to fewer tokens",
} as const;

export interface Unit {
  id: string;
  path: string;
  decl: string;
  start: number;
  end: number;
  chars: number;
  exported: boolean;
  split: string;
  label: boolean;
  label_majority: boolean;
}
const REPO_DIR = join(RUNS_DIR, "run1", "repo");
const texts = new Map<string, string[]>();
const fileLines = (path: string) => {
  if (!texts.has(path))
    texts.set(
      path,
      execFileSync("git", ["-C", REPO_DIR, "show", `${FROM_TAG}:${path}`])
        .toString()
        .split("\n"),
    );
  return texts.get(path)!;
};
export const code = (u: Unit) =>
  fileLines(u.path)
    .slice(u.start - 1, u.end)
    .join("\n");
export const loadUnits = (): Unit[] =>
  JSON.parse(readFileSync(join(DATA, "t1-got.json"), "utf8")).units;

export function stateFor(u: Unit, level: Exclude<Level, "P">, all: Unit[]) {
  const unit = { file: u.path, declaration: u.decl, code: code(u) };
  if (level === "U0") return { library: "got, an HTTP client for Node.js", unit };
  const outline = all.filter((x) => x.path === u.path).map((x) => x.decl);
  return { library: "got, an HTTP client for Node.js", file_outline: outline, unit };
}

export function packs(units: Unit[]) {
  const out: { units: Unit[]; state: Record<string, unknown>; questions: Questions }[] = [];
  for (const path of [...new Set(units.map((u) => u.path))]) {
    let chunk: Unit[] = [];
    let size = 0;
    const flush = () => {
      if (!chunk.length) return;
      const questions: Questions = {};
      chunk.forEach((u, i) => {
        questions[`u${i + 1}`] = {
          type: "noul",
          instructions: `About \`${u.decl}\` only: ${INSTRUCTIONS}`,
        };
      });
      out.push({
        units: chunk,
        state: {
          library: "got, an HTTP client for Node.js",
          file: path,
          declarations: chunk.map((u) => ({ declaration: u.decl, code: code(u) })),
        },
        questions,
      });
      chunk = [];
      size = 0;
    };
    for (const u of units.filter((x) => x.path === path)) {
      if (size + u.chars > PROTOCOL.packed_max_chars) flush();
      chunk.push(u);
      size += u.chars;
    }
    flush();
  }
  return out;
}
