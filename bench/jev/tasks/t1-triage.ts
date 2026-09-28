/**
 * T1, tier R. Question: before an agent reads a source, can a decider pick out the sections worth
 * reading well enough that skipping the rest loses almost nothing a reader would cite?
 * Pre-registered: committed before any model sees these sections.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { rfcFile, type T1Item } from "../builders/t1-sections.ts";
import { DATA } from "../lib/paths.ts";
import type { Questions } from "../lib/questions.ts";
import { rfcIndex } from "../lib/rfc-index.ts";
import { splitRfc, type Section } from "../lib/sections.ts";

export type Level = "S0" | "S1" | "S2" | "P";
export const LEVELS: Level[] = ["S0", "S1", "S2", "P"];

const INSTRUCTIONS =
  "Would another specification, or a technical documentation page about this protocol, need to cite this section " +
  "specifically, because it defines a rule, a message or data format, a procedure, a value, an error condition or a " +
  "term that others depend on? Introductions, overviews, motivation, examples that only restate other sections, and " +
  "administrative text are not cited this way.";

export const QUESTIONS: Questions = { cite_worthy: { type: "noul", instructions: INSTRUCTIONS } };

export const PROTOCOL = {
  // A section is kept for reading when its score >= tau; tau is the largest value whose
  // recall of cited sections on the calibration RFCs is at least this.
  calibration_min_recall: 0.95,
  // The gate: recall on the test RFCs at tau, and the share of characters skipped.
  gate_min_recall: 0.95,
  // Packed level: whole sections, in order, up to this many characters per call.
  packed_max_chars: 60000,
  toc_max_chars: 6000,
  selection: "max AUROC on calibration; ties broken by fewer input tokens",
} as const;

export interface T1Case extends T1Item {
  text: string;
  rfcTitle: string;
  abstract: string;
  toc: string;
}

const KEYWORDS =
  /\b(MUST NOT|MUST|REQUIRED|SHALL NOT|SHALL|SHOULD NOT|SHOULD|RECOMMENDED|MAY|OPTIONAL)\b/g;

/** Deterministic arms: scores, higher means read it. */
export const normativeCount = (c: T1Case) => (c.text.match(KEYWORDS) ?? []).length;
export const sectionLength = (c: T1Case) => c.chars;

export function loadCases(): T1Case[] {
  const { items } = JSON.parse(readFileSync(join(DATA, "t1-sections.json"), "utf8")) as {
    items: T1Item[];
  };
  const index = rfcIndex();
  const docs = new Map<string, Section[]>();
  return items.map((it) => {
    if (!docs.has(it.rfc)) docs.set(it.rfc, splitRfc(readFileSync(rfcFile(it.rfc), "latin1")));
    const sections = docs.get(it.rfc)!;
    const s = sections.find((x) => x.number === it.number && x.start === it.start)!;
    const toc = sections
      .map((x) => `${x.number} ${x.title}`)
      .join("\n")
      .slice(0, PROTOCOL.toc_max_chars);
    const e = index.get(it.rfc);
    return { ...it, text: s.text, rfcTitle: e?.title ?? "", abstract: e?.abstract ?? "", toc };
  });
}

export function stateFor(c: T1Case, level: Exclude<Level, "P">): Record<string, unknown> {
  const section = { number: c.number, title: c.title, text: c.text };
  if (level === "S0") return { rfc: `${c.rfc}: ${c.rfcTitle}`, section };
  if (level === "S1") return { rfc: `${c.rfc}: ${c.rfcTitle}`, abstract: c.abstract, section };
  return {
    rfc: `${c.rfc}: ${c.rfcTitle}`,
    abstract: c.abstract,
    table_of_contents: c.toc,
    section,
  };
}

/** The packed level: consecutive sections of one RFC as one state, one question per section. */
export function packs(
  cases: T1Case[],
): { cases: T1Case[]; state: Record<string, unknown>; questions: Questions }[] {
  const out: { cases: T1Case[]; state: Record<string, unknown>; questions: Questions }[] = [];
  const byRfc = new Map<string, T1Case[]>();
  for (const c of cases) byRfc.set(c.rfc, [...(byRfc.get(c.rfc) ?? []), c]);
  for (const group of byRfc.values()) {
    let chunk: T1Case[] = [];
    let size = 0;
    const flush = () => {
      if (!chunk.length) return;
      const first = chunk[0]!;
      const questions: Questions = {};
      chunk.forEach((c, i) => {
        questions[`s${i + 1}`] = {
          type: "noul",
          instructions: `About section ${c.number} ("${c.title}") only: ${INSTRUCTIONS}`,
        };
      });
      out.push({
        cases: chunk,
        state: {
          rfc: `${first.rfc}: ${first.rfcTitle}`,
          abstract: first.abstract,
          sections: chunk.map((c) => ({ number: c.number, title: c.title, text: c.text })),
        },
        questions,
      });
      chunk = [];
      size = 0;
    };
    for (const c of group) {
      if (size + c.text.length > PROTOCOL.packed_max_chars) flush();
      chunk.push(c);
      size += c.text.length;
    }
    flush();
  }
  return out;
}
