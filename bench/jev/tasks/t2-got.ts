/**
 * T2, tier C: citations an ingest agent wrote into got v13.0.0, each paired with the code it cites
 * and with a hard negative: the same claim against the declaration in the same file that shares
 * the most identifiers with it. Pre-registered before any model sees these pairs.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DATA } from "../lib/paths.ts";
import { shuffle } from "../lib/rng.ts";
import { units } from "../lib/ts-decls.ts";
import { FROM_TAG, RUNS_DIR } from "./ingest-got.ts";
import { QUESTIONS as SCIFACT_QUESTIONS } from "./t2-scifact.ts";

export type Level = "C0" | "C1" | "C2";
export const LEVELS: Level[] = ["C0", "C1", "C2"];
export const QUESTIONS = SCIFACT_QUESTIONS;
export const PROTOCOL = {
  sample: 150,
  seed: 20261009,
  pad_lines: 10,
  primary_level: "C0",
  annotator: "claude-opus-5-5",
  max_lines: 120,
} as const;

const REPO_DIR = join(RUNS_DIR, "run1", "repo");
const cache = new Map<string, string[]>();
const fileLines = (path: string) => {
  if (!cache.has(path))
    cache.set(
      path,
      execFileSync("git", ["-C", REPO_DIR, "show", `${FROM_TAG}:${path}`])
        .toString()
        .split("\n"),
    );
  return cache.get(path)!;
};
const slice = (path: string, a: number, b: number) =>
  fileLines(path)
    .slice(Math.max(0, a - 1), b)
    .join("\n");
const ids = (s: string) => new Set(s.match(/[A-Za-z_$][A-Za-z0-9_$]{2,}/g) ?? []);
const overlap = (a: Set<string>, b: Set<string>) => {
  let i = 0;
  for (const x of a) if (b.has(x)) i++;
  return i / (a.size || 1);
};

export interface Pair {
  id: string;
  kind: "real" | "negative";
  path: string;
  claim: string;
  start: number;
  end: number;
}

export function citedText(p: Pair, level: Level): string {
  if (level === "C0") return slice(p.path, p.start, p.end);
  if (level === "C1")
    return slice(p.path, p.start - PROTOCOL.pad_lines, p.end + PROTOCOL.pad_lines);
  const u = units(fileLines(p.path).join("\n"))
    .filter((d) => d.start <= p.start && d.end >= p.end)
    .sort((a, b) => a.end - a.start - (b.end - b.start))[0];
  return u
    ? u.text.slice(0, 12000)
    : slice(p.path, p.start - PROTOCOL.pad_lines, p.end + PROTOCOL.pad_lines);
}

export function loadPairs(): Pair[] {
  const { items } = JSON.parse(readFileSync(join(DATA, "t3-got.json"), "utf8")) as {
    items: { id: string; path: string; start: number; end: number; claim: string }[];
  };
  const usable = items.filter(
    (c) => c.claim.length >= 30 && c.claim.length <= 600 && c.end - c.start <= PROTOCOL.max_lines,
  );
  return shuffle(usable, PROTOCOL.seed)
    .slice(0, PROTOCOL.sample)
    .flatMap((c, i) => {
      const w = ids(c.claim);
      const others = units(fileLines(c.path).join("\n")).filter(
        (u) => u.end < c.start || u.start > c.end,
      );
      const best = others
        .map((u) => ({ u, score: overlap(w, ids(u.text)) }))
        .sort((a, b) => b.score - a.score)[0]?.u;
      const len = c.end - c.start;
      const neg = best
        ? { start: best.start, end: Math.min(best.end, best.start + len) }
        : { start: 1, end: 1 + len };
      return [
        {
          id: `g${i}-real`,
          kind: "real" as const,
          path: c.path,
          claim: c.claim,
          start: c.start,
          end: c.end,
        },
        {
          id: `g${i}-neg`,
          kind: "negative" as const,
          path: c.path,
          claim: c.claim,
          start: neg.start,
          end: neg.end,
        },
      ];
    });
}

export const stateFor = (p: Pair, level: Level) => ({
  claim: p.claim,
  file: p.path,
  cited_code: citedText(p, level),
});
