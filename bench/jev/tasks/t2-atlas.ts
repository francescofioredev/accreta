/**
 * T2, tier A: citations an ingest agent actually wrote. Each real citation is paired with the lines
 * it cites (label unknown: it is what the check exists to find out) and with a constructed negative:
 * the same claim against the most lexically similar other section of the same RFC.
 * Pre-registered before any model sees these pairs.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DATA } from "../lib/paths.ts";
import type { Questions } from "../lib/questions.ts";
import { shuffle } from "../lib/rng.ts";
import { splitRfc } from "../lib/sections.ts";
import { RUNS_DIR, TARGETS } from "./ingest-atlas.ts";
import { QUESTIONS as SCIFACT_QUESTIONS } from "./t2-scifact.ts";
import type { Citation } from "../builders/tier-a.ts";

export type Level = "C0" | "C1" | "C2";
export const LEVELS: Level[] = ["C0", "C1", "C2"];
export const QUESTIONS: Questions = SCIFACT_QUESTIONS;
export const PROTOCOL = {
  sample_per_run: 50,
  seed: 20261004,
  pad_lines: 10,
  section_max_chars: 12000,
  // Opus labels every sampled pair; the maintainer audits a seeded 30 of them blind.
  annotator: "claude-opus-5-5",
  audit_pairs: 30,
  // No calibration set of its own: C1 (the cited lines plus ten either side, what opening a
  // citation shows) is the primary level, and tau is carried over from the SciFact calibration.
  primary_level: "C1",
} as const;

const lines = new Map<string, string[]>();
function textOf(rfc: string): string[] {
  if (!lines.has(rfc)) {
    const t = TARGETS.find((x) => x.rfc === rfc)!;
    lines.set(
      rfc,
      readFileSync(join(RUNS_DIR, "run1", t.path), "latin1")
        .replace(/\r\n/g, "\n")
        .split("\n"),
    );
  }
  return lines.get(rfc)!;
}
const slice = (rfc: string, a: number, b: number) =>
  textOf(rfc)
    .slice(Math.max(0, a - 1), b)
    .join("\n")
    .trim();

export function citedText(rfc: string, start: number, end: number, level: Level): string {
  if (level === "C0") return slice(rfc, start, end);
  if (level === "C1") return slice(rfc, start - PROTOCOL.pad_lines, end + PROTOCOL.pad_lines);
  const s = splitRfc(textOf(rfc).join("\n")).find((x) => x.start <= start && x.end >= start);
  return s
    ? s.text.slice(0, PROTOCOL.section_max_chars)
    : slice(rfc, start - PROTOCOL.pad_lines, end + PROTOCOL.pad_lines);
}

const words = (s: string) => new Set(s.toLowerCase().match(/[a-z0-9-]{3,}/g) ?? []);
const jaccard = (a: Set<string>, b: Set<string>) => {
  let i = 0;
  for (const x of a) if (b.has(x)) i++;
  return i / (a.size + b.size - i || 1);
};

/** The other section of the same RFC that shares most vocabulary with the claim: a hard negative. */
const sectionsOf = new Map<string, { start: number; end: number; words: Set<string> }[]>();

export function hardNegative(c: Citation): { start: number; end: number } {
  if (!sectionsOf.has(c.rfc)) {
    sectionsOf.set(
      c.rfc,
      splitRfc(textOf(c.rfc).join("\n"))
        .filter((s) => s.text.length >= 200)
        .map((s) => ({ start: s.start, end: s.end, words: words(s.text) })),
    );
  }
  const w = words(c.claim);
  const others = sectionsOf.get(c.rfc)!.filter((s) => s.end < c.start || s.start > c.end);
  const best = others
    .map((s) => ({ s, score: jaccard(w, s.words) }))
    .sort((a, b) => b.score - a.score)[0]!.s;
  const len = Math.min(c.end - c.start, best.end - best.start);
  return { start: best.start, end: best.start + len };
}

export interface Pair {
  id: string;
  kind: "real" | "negative";
  run: number;
  rfc: string;
  claim: string;
  start: number;
  end: number;
}

export function loadPairs(): Pair[] {
  const { citations } = JSON.parse(readFileSync(join(DATA, "tier-a.json"), "utf8")) as {
    citations: Citation[];
  };
  const usable = citations.filter(
    (c) => c.claim.length >= 30 && c.claim.length <= 600 && c.end - c.start <= 120,
  );
  return [1, 2, 3].flatMap((run) =>
    shuffle(
      usable.filter((c) => c.run === run),
      PROTOCOL.seed + run,
    )
      .slice(0, PROTOCOL.sample_per_run)
      .flatMap((c, i) => {
        const neg = hardNegative(c);
        return [
          {
            id: `r${run}-${i}-real`,
            kind: "real" as const,
            run,
            rfc: c.rfc,
            claim: c.claim,
            start: c.start,
            end: c.end,
          },
          {
            id: `r${run}-${i}-neg`,
            kind: "negative" as const,
            run,
            rfc: c.rfc,
            claim: c.claim,
            start: neg.start,
            end: neg.end,
          },
        ];
      }),
  );
}

export const stateFor = (p: Pair, level: Level) => ({
  claim: p.claim,
  cited_text: citedText(p.rfc, p.start, p.end, level),
});
