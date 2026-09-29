/**
 * T3 amendment 1: context and question form as explicit factors, plus an exploratory batching arm.
 * Committed before any call these configurations make.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { wordHunks, type Hunk } from "../lib/diff.ts";
import { EXTERNAL } from "../lib/paths.ts";
import type { Questions } from "../lib/questions.ts";
import { splitRfc } from "../lib/sections.ts";
import { QUESTIONS, type T3Case } from "./t3-errata.ts";

export type Level = "L0" | "L1" | "L1b" | "L2";
export type Form = "noul" | "choice";
export const LEVELS: Level[] = ["L0", "L1", "L1b", "L2"];
export const FORMS: Form[] = ["noul", "choice"];

export const AMENDMENT = {
  // The configuration is chosen by AUROC on the calibration split only, then scored once on test.
  selection: "max AUROC on calibration; ties broken by fewer input tokens",
  surrounding_max_chars: 4000,
  hunk_pad_words: 6,
  batch_sizes: [1, 5, 10, 25],
  batch_seed: 20260928,
} as const;

const CHOICE: Questions = {
  meaning_changed: {
    type: "choice",
    instructions: "What kind of change turns the original text into the corrected text?",
    criteria: {
      technical:
        "changes the technical meaning: what an implementation must, should or may do, a value, a format or grammar rule, or a described behaviour",
      editorial:
        "fixes spelling, grammar, punctuation or layout and leaves the technical meaning unchanged",
    },
  },
};

export const questionsFor = (form: Form): Questions => (form === "noul" ? QUESTIONS : CHOICE);

/** P(meaning changed) from either form. */
export const pChanged = (
  a: { p?: number; probabilities?: Record<string, number> } | undefined,
): number | null => a?.p ?? a?.probabilities?.technical ?? null;

const squash = (s: string) => s.replace(/\s+/g, " ").trim();
const renderHunks = (hs: Hunk[]) =>
  hs.map((h) => `…${h.before} [-${h.removed}-] [+${h.added}+] ${h.after}…`);

const rfcTexts = new Map<string, string | null>();
function rfcText(rfc: string): string | null {
  if (!rfcTexts.has(rfc)) {
    const f = join(EXTERNAL, "rfc", "all", `rfc${Number(rfc.replace("RFC", ""))}.txt`);
    rfcTexts.set(rfc, existsSync(f) ? readFileSync(f, "latin1") : null);
  }
  return rfcTexts.get(rfc)!;
}

/** The section around the erratum, capped and centred on where the original text sits. */
export function surrounding(c: T3Case): {
  text: string;
  located: "text" | "document" | "section" | "none";
} {
  const txt = rfcText(c.rfc);
  if (!txt) return { text: "", located: "none" };
  const sections = splitRfc(txt);
  const probe = squash(c.orig).slice(0, 60);
  const cap = (s: string, at: number) => {
    const half = AMENDMENT.surrounding_max_chars / 2;
    const from = Math.max(0, Math.min(at - half, s.length - AMENDMENT.surrounding_max_chars));
    return s.slice(from, from + AMENDMENT.surrounding_max_chars);
  };
  if (probe.length >= 20) {
    const hit = sections.find((s) => squash(s.text).includes(probe));
    if (hit)
      return { text: cap(squash(hit.text), squash(hit.text).indexOf(probe)), located: "text" };
    // Page furniture can split a passage across the section boundary the splitter sees.
    const flat = squash(txt);
    if (flat.includes(probe)) return { text: cap(flat, flat.indexOf(probe)), located: "document" };
  }
  const bySection = sections.find(
    (s) => s.number === c.section.replace(/^Section\s*/i, "").replace(/\.$/, ""),
  );
  return bySection
    ? { text: cap(squash(bySection.text), 0), located: "section" }
    : { text: "", located: "none" };
}

export function stateFor(c: T3Case, level: Level): Record<string, unknown> {
  if (level === "L0") return c.state;
  const changes = renderHunks(wordHunks(c.orig, c.corrected, AMENDMENT.hunk_pad_words));
  if (level === "L1b") return { rfc: c.state.rfc, section: c.section, changes };
  if (level === "L1") return { ...c.state, changes };
  return { ...c.state, changes, surrounding_section: surrounding(c).text };
}

/** Batching: one shared rubric, one short question per packed item. */
export function packed(
  cases: T3Case[],
  level: Level,
): { state: Record<string, unknown>; questions: Questions } {
  const items = cases.map((c, i) => ({ item: `e${i + 1}`, ...stateFor(c, level) }));
  const questions: Questions = {};
  items.forEach((it) => {
    questions[it.item] = {
      type: "noul",
      instructions: `For item ${it.item} only: does its corrected text change its original text's technical meaning, as the rubric defines it?`,
    };
  });
  return { state: { rubric: QUESTIONS.meaning_changed!.instructions, items }, questions };
}

/** L3, the production shape: a claim written from the original, the diff, both texts. */
export const L3_QUESTIONS: Questions = {
  claim_invalidated: {
    type: "noul",
    instructions:
      "The claim was written from the original text. Given the corrected text, is the claim now wrong or no longer " +
      "supported? A correction that only fixes spelling, grammar, punctuation or layout leaves the claim valid.",
  },
};

export const l3State = (c: T3Case, claim: string) => ({ claim, ...stateFor(c, "L1") });
