import { BLOCK_START_RE, DEFINITION_RE, FENCE_RE, REFERENCE_RE, sentences } from "../citations.ts";

export interface UncitedSentence {
  /** 1-based line within the page body, which excludes the frontmatter. */
  line: number;
  text: string;
}

// Fewer words than this is a label or a stub, not a claim.
const MIN_WORDS = 3;
const LIST_MARKER_RE = /^ {0,3}(?:[-*+]|\d+[.)])\s+/;
const SKIPPED_LINE_RE = /^(?: {0,3}\||\s*<|\s*\[[^\]]+\]:\s*\S)/;

const hasReference = (sentence: string) => [...sentence.matchAll(REFERENCE_RE)].length > 0;

const endsWithMarker = (sentence: string, marker: string) =>
  sentence
    .replace(REFERENCE_RE, "")
    .trim()
    .replace(/[.!?]+$/, "")
    .trimEnd()
    .endsWith(marker);

function wordCount(sentence: string): number {
  const text = sentence.replace(REFERENCE_RE, "").replace(/\[\[[^\]|]*\|?([^\]]*)\]\]/g, "$1");
  return text.match(/\p{L}[\p{L}\p{N}'’-]*/gu)?.length ?? 0;
}

/** Prose sentences with neither a footnote nor the marker; a sentence that is only the marker marks the one before. */
export function uncitedSentences(body: string, marker: string): UncitedSentence[] {
  const out: UncitedSentence[] = [];
  let paragraph: { line: number; text: string[] } | null = null;
  let fenced = false;
  let inDefinition = false;
  let afterBlank = false;

  const flush = () => {
    if (paragraph === null) return;
    const parts = sentences(paragraph.text.join(" ").replace(/\s+/g, " ").trim());
    parts.forEach((part, index) => {
      const sentence = part.trim();
      const markerOnly =
        endsWithMarker(sentence, marker) && wordCount(sentence.replace(marker, "")) === 0;
      if (markerOnly) {
        if (index > 0) {
          const last = out.at(-1);
          if (last && last.text === parts[index - 1]!.trim()) out.pop();
        }
        return;
      }
      if (hasReference(sentence) || endsWithMarker(sentence, marker)) return;
      if (wordCount(sentence) < MIN_WORDS) return;
      out.push({ line: paragraph!.line, text: sentence });
    });
    paragraph = null;
  };

  body.split("\n").forEach((raw, index) => {
    const line = raw.replace(/\r$/, "");
    const blank = line.trim() === "";
    if (FENCE_RE.test(line)) {
      flush();
      fenced = !fenced;
      afterBlank = false;
      return;
    }
    if (fenced) return;
    if (DEFINITION_RE.test(line)) {
      flush();
      inDefinition = true;
      afterBlank = false;
      return;
    }
    if (inDefinition) {
      if ((afterBlank && /^\S/.test(line)) || BLOCK_START_RE.test(line)) inDefinition = false;
      else {
        afterBlank = blank;
        return;
      }
    }
    afterBlank = blank;
    if (blank) {
      flush();
      return;
    }
    if (paragraph === null && /^(?: {4}|\t)/.test(line)) return;
    if (SKIPPED_LINE_RE.test(line) || /^ {0,3}(?:#{1,6}(?:\s|$)|>)/.test(line)) {
      flush();
      return;
    }
    if (LIST_MARKER_RE.test(line)) {
      flush();
      const text = line.replace(LIST_MARKER_RE, "");
      if (/^(?:([-*_])(\s*\1){2,})\s*$/.test(line.trim())) return;
      paragraph = { line: index + 1, text: [text] };
      return;
    }
    if (BLOCK_START_RE.test(line)) {
      flush();
      return;
    }
    if (paragraph === null) paragraph = { line: index + 1, text: [line] };
    else paragraph.text.push(line);
  });
  flush();
  return out;
}
