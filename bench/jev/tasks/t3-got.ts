/**
 * T3, tier C. Two questions on code drift, got v13.0.0 → v14.4.0:
 *  1. Is the free deterministic step safe? Citations whose cited lines no diff hunk touches are
 *     cleared without a model; a sample of them is labelled to count the claims it wrongly clears.
 *  2. On citations a hunk does touch, can a decider tell a claim that still holds from one that broke?
 * Pre-registered before any model sees these items.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { wordHunks } from "../lib/diff.ts";
import { DATA } from "../lib/paths.ts";
import { shuffle } from "../lib/rng.ts";
import { FROM_TAG, RUNS_DIR, TO_TAG } from "./ingest-got.ts";
import { L3_QUESTIONS } from "./t3-ladder.ts";

export const PROTOCOL = {
  // Untouched citations the free step would clear, labelled to measure its false-clear rate.
  untouched_sample: 60,
  untouched_seed: 20261005,
  annotator: "claude-opus-5-5",
  audit_items: 30,
  // No calibration split: tau is fixed by the original T3 rule on a seeded third of the touched items.
  calibration_share: 1 / 3,
  calibration_seed: 20261006,
  pad_lines: 3,
} as const;
export const QUESTIONS = L3_QUESTIONS;

export interface GotItem {
  id: string;
  path: string;
  start: number;
  end: number;
  claim: string;
  touched: boolean;
  new_start: number | null;
  new_end: number | null;
  declaration: string | null;
  declaration_fate: string;
  file_changed: boolean;
}

const REPO_DIR = join(RUNS_DIR, "run1", "repo");
const files = new Map<string, string[] | null>();
function lines(tag: string, path: string): string[] | null {
  const key = `${tag}:${path}`;
  if (!files.has(key)) {
    try {
      files.set(key, execFileSync("git", ["-C", REPO_DIR, "show", key]).toString().split("\n"));
    } catch {
      files.set(key, null);
    }
  }
  return files.get(key)!;
}
const slice = (ls: string[] | null, a: number, b: number) =>
  ls
    ? ls.slice(Math.max(0, a - 1 - PROTOCOL.pad_lines), b + PROTOCOL.pad_lines).join("\n")
    : "(file removed)";

export function stateFor(it: GotItem) {
  const before = slice(lines(FROM_TAG, it.path), it.start, it.end);
  const after = it.new_start
    ? slice(lines(TO_TAG, it.path), it.new_start, it.new_end!)
    : "(file removed)";
  const changes = wordHunks(before, after, 6).map(
    (h) => `…${h.before} [-${h.removed}-] [+${h.added}+] ${h.after}…`,
  );
  return { claim: it.claim, file: it.path, original: before, corrected: after, changes };
}

export function loadItems() {
  const { items } = JSON.parse(readFileSync(join(DATA, "t3-got.json"), "utf8")) as {
    items: GotItem[];
  };
  const touched = shuffle(
    items.filter((i) => i.touched),
    PROTOCOL.calibration_seed,
  );
  const cut = Math.round(touched.length * PROTOCOL.calibration_share);
  const untouched = shuffle(
    items.filter((i) => !i.touched),
    PROTOCOL.untouched_seed,
  ).slice(0, PROTOCOL.untouched_sample);
  return {
    touched: touched.map((t, i) => ({ ...t, split: i < cut ? "calibration" : "test" })),
    untouched: untouched.map((t) => ({ ...t, split: "untouched" })),
  };
}
