/**
 * T3, tier R. Question: given the text a claim was written from and the text that replaced it,
 * can a decider tell a change of meaning from a cosmetic one well enough to clear drift unattended?
 * The protocol below is pre-registered: it was committed before any model saw these items.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadErrata, type T3Item } from "../builders/errata.ts";
import { DATA } from "../lib/paths.ts";
import type { Questions } from "../lib/questions.ts";
import { rfcIndex } from "../lib/rfc-index.ts";

// Mirrors the IETF's own definition of an editorial erratum, so the question asks what the label means.
export const QUESTIONS: Questions = {
  meaning_changed: {
    type: "noul",
    instructions:
      "Does the corrected text change the technical meaning of the original text: what an implementation must, " +
      "should or may do, a value, a format or grammar rule, or a described behaviour, so that a statement someone " +
      "wrote from the original text could now be wrong? A fix to spelling, grammar, punctuation or layout that " +
      "leaves the technical meaning unchanged is not a change of meaning.",
  },
};

/** Pre-registered operating rule. */
export const PROTOCOL = {
  // An item is cleared as "still valid" when P(meaning changed) < tau.
  // tau is the largest grid value whose false-"still valid" rate on the calibration split is at most this.
  calibration_max_false_still_valid: 0.02,
  tau_grid: Array.from({ length: 99 }, (_, i) => (i + 1) / 100),
  // The gate from docs/research/2026-08-review/experiments/model-routing.md, judged on the test split.
  gate_false_still_valid: 0.05,
  // Jev repeated on this many test items per class to measure whether its answers vary.
  repeat_items_per_class: 50,
  haiku_samples: 1,
} as const;

const KEYWORDS =
  /\b(MUST NOT|MUST|REQUIRED|SHALL NOT|SHALL|SHOULD NOT|SHOULD|RECOMMENDED|NOT RECOMMENDED|MAY|OPTIONAL)\b/g;
const bag = (xs: string[]) => xs.sort().join("\u0000");
const squash = (s: string) => s.replace(/\s+/g, " ").trim();

/** Deterministic arm 1: only a change in non-whitespace characters counts as a change. */
export const whitespaceOnly = (orig: string, corrected: string) =>
  squash(orig) !== squash(corrected);

/** Deterministic arm 2: a change counts only if RFC 2119 keywords or numbers differ. */
export const normativeRegex = (orig: string, corrected: string) =>
  bag(orig.match(KEYWORDS) ?? []) !== bag(corrected.match(KEYWORDS) ?? []) ||
  bag(orig.match(/\d+/g) ?? []) !== bag(corrected.match(/\d+/g) ?? []);

export interface T3Case extends T3Item {
  orig: string;
  corrected: string;
  state: { rfc: string; section: string; original: string; corrected: string };
}

export async function loadCases(): Promise<T3Case[]> {
  const { items } = JSON.parse(readFileSync(join(DATA, "t3-errata.json"), "utf8")) as {
    items: T3Item[];
  };
  const errata = await loadErrata();
  const index = rfcIndex();
  return items.map((item) => {
    const e = errata.get(item.id)!;
    const title = index.get(item.rfc)?.title ?? "";
    return {
      ...item,
      orig: e.orig_text!,
      corrected: e.correct_text!,
      state: {
        rfc: `${item.rfc}: ${title}`,
        section: item.section,
        original: e.orig_text!,
        corrected: e.correct_text!,
      },
    };
  });
}
