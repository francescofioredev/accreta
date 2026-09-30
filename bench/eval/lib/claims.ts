// What counts as a claim, mechanically; protocol.md pre-registers these rules.

export interface Claim {
  text: string;
  /** Footnote ids the sentence references. */
  footnotes: string[];
}

/** A sentence needs this many words to count: "See [[x]]." is navigation, not a claim. */
export const MIN_WORDS = 5;

const FENCE_RE = /^\s*(```|~~~)/;
const DEFINITION_RE = /^\[\^[^\]\s]+\]:/;
const HEADING_RE = /^\s{0,3}#{1,6}\s/;
const TABLE_RE = /^\s*\|/;
const QUOTE_RE = /^\s*>/;
const LIST_RE = /^\s*(?:[-*+]|\d+[.)])\s+/;
const REFERENCE_RE = /\[\^([^\]\s]+)\](?!:)/g;
// The same boundary as core's extractFootnotes, so a claim here is a claim there.
const SENTENCE_END_RE = /([.!?](?:\[\^[^\]\s]+\])*)\s+(?=[A-Z`*"(])/;
const WORD_RE = /[\p{L}\p{N}][\p{L}\p{N}'’_-]*/gu;

/** Prose units of a page body: paragraphs and list items, without code, headings, tables or quotes. */
function units(body: string): string[] {
  const out: string[] = [];
  let current: string[] = [];
  let fenced = false;
  const flush = () => {
    if (current.length) out.push(current.join(" "));
    current = [];
  };
  for (const raw of body.replace(/<!--[\s\S]*?-->/g, "").split("\n")) {
    if (FENCE_RE.test(raw)) {
      fenced = !fenced;
      flush();
      continue;
    }
    if (fenced) continue;
    if (raw.trim() === "") {
      flush();
      continue;
    }
    if (
      HEADING_RE.test(raw) ||
      TABLE_RE.test(raw) ||
      QUOTE_RE.test(raw) ||
      DEFINITION_RE.test(raw)
    ) {
      flush();
      continue;
    }
    if (LIST_RE.test(raw)) {
      flush();
      current.push(raw.replace(LIST_RE, ""));
      continue;
    }
    current.push(raw.trim());
  }
  flush();
  return out;
}

function sentences(unit: string): string[] {
  const parts = unit.replace(/\s+/g, " ").trim().split(SENTENCE_END_RE);
  const out: string[] = [];
  for (let i = 0; i < parts.length; i += 2) out.push(parts[i]! + (parts[i + 1] ?? ""));
  return out;
}

export function claims(body: string): Claim[] {
  const out: Claim[] = [];
  for (const unit of units(body)) {
    for (const sentence of sentences(unit)) {
      const footnotes = [...new Set([...sentence.matchAll(REFERENCE_RE)].map((m) => m[1]!))];
      const text = sentence.replace(REFERENCE_RE, "").trim();
      if ((text.match(WORD_RE) ?? []).length >= MIN_WORDS) out.push({ text, footnotes });
    }
  }
  return out;
}
