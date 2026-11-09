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

const norm = (line: string) => line.trim().replace(/\s+/g, " ");

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
  let paragraph: { text: string[]; lines: number[] } | null = null;
  let inComment = false;
  let fenced = false;
  let inDefinition = false;
  let afterBlank = false;

  const flush = () => {
    if (paragraph === null) return;
    const { text, lines } = paragraph;
    const starts = text.map((_, i) => text.slice(0, i).join(" ").length + (i > 0 ? 1 : 0));
    const lineAt = (offset: number) => lines[starts.findLastIndex((start) => start <= offset)]!;
    let offset = 0;
    const parts = sentences(text.join(" "));
    parts.forEach((part, index) => {
      const sentence = part.trim();
      const at = offset;
      offset += part.length + 1;
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
      out.push({ line: lineAt(at), text: sentence });
    });
    paragraph = null;
  };

  body.split("\n").forEach((raw, index) => {
    const line = raw.replace(/\r$/, "");
    const blank = line.trim() === "";
    if (FENCE_RE.test(line)) {
      flush();
      fenced = !fenced;
      inDefinition = false;
      afterBlank = false;
      return;
    }
    if (fenced) return;
    if (inComment) {
      inComment = !line.includes("-->");
      return;
    }
    if (/^\s*<!--/.test(line) && !line.includes("-->")) {
      flush();
      inComment = true;
      return;
    }
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
      paragraph = { text: [norm(text)], lines: [index + 1] };
      return;
    }
    if (BLOCK_START_RE.test(line)) {
      flush();
      return;
    }
    if (paragraph === null) paragraph = { text: [norm(line)], lines: [index + 1] };
    else {
      paragraph.text.push(norm(line));
      paragraph.lines.push(index + 1);
    }
  });
  flush();
  return out;
}
