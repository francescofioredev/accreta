import { BLOCK_START_RE, DEFINITION_RE, FENCE_RE } from "./citations.ts";

const SEPARATOR = /[^\p{L}\p{N}\p{M}_]+/u;
const WORD = /[\p{L}\p{N}]/u;

/** The runs of letters, digits and marks with an underscore in them, in order, repeats kept. */
export function identifiersIn(text: string): string[] {
  // Most pages have no underscore, and a split per page is what the rebuild would pay for them.
  if (!text.includes("_")) return [];
  // Markdown writes `stale\_served` for stale_served; the backslash must not split it.
  return text
    .replaceAll("\\_", "_")
    .split(SEPARATOR)
    .filter((run) => run.includes("_") && WORD.test(run));
}

// A line opening with `<!--` starts an HTML block, which runs to the line holding `-->`.
const COMMENT_BLOCK_RE = /^ {0,3}<!--/;
const REFERENCE_DEFINITION_RE = /^ {0,3}\[(?!\^)[^\]]+\]:\s*\S/;
// Inline, an unclosed `<!--` is literal text; `<!-->` and `<!--->` are whole comments.
const COMMENT_RE = /<!--(?:>|->|[\s\S]*?-->)/g;
const CODE_SPAN_RE = /(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)/g;
const LINK_DESTINATION_RE =
  /\]\(\s*(?:<[^>\n]*>|(?:[^()\s]|\([^()\s]*\))*)(?:\s+(?:"[^"]*"|'[^']*'|\([^()]*\)))?\s*\)/g;
const LINK_REFERENCE_RE = /\]\[[^\]\n]*\]/g;
const LABELLED_WIKILINK_RE = /\[\[[^\]|\n]*\|([^\]\n]*)\]\]/g;
// A reader sees a footnote reference as a number, never its id.
const FOOTNOTE_REFERENCE_RE = /\[\^[^\]\s]+\]/g;
const SPAN = /\0(\d+)\0/g;

/** The body as a reader sees it, for identifier extraction: fenced and inline code kept. */
export function visibleText(body: string): string {
  const lines = body.split("\n");
  const out: string[] = [];
  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length > 0) out.push(visibleInline(paragraph.join("\n")));
    paragraph = [];
  };
  let fenced = false;
  let within = false;
  let afterBlank = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (FENCE_RE.test(line)) {
      flush();
      fenced = !fenced;
      within = false;
      afterBlank = false;
      out.push(line);
      continue;
    }
    if (fenced) {
      out.push(line);
      continue;
    }
    if (COMMENT_BLOCK_RE.test(line)) {
      flush();
      while (i < lines.length && !lines[i]!.includes("-->")) i++;
      // Text after the comment on its closing line is still rendered.
      if (i < lines.length) out.push(visibleInline(lines[i]!.slice(lines[i]!.indexOf("-->") + 3)));
      within = false;
      afterBlank = false;
      continue;
    }
    if (DEFINITION_RE.test(line)) within = true;
    else if ((afterBlank && /^\S/.test(line)) || BLOCK_START_RE.test(line)) within = false;
    afterBlank = line.trim() === "";
    if (within || afterBlank || REFERENCE_DEFINITION_RE.test(line)) {
      flush();
      continue;
    }
    paragraph.push(line);
  }
  flush();
  return out.join("\n");
}

function visibleInline(text: string): string {
  const spans: string[] = [];
  return text
    .replace(CODE_SPAN_RE, (code) => `\0${spans.push(code) - 1}\0`)
    .replace(COMMENT_RE, "")
    .replace(FOOTNOTE_REFERENCE_RE, "")
    .replace(LINK_DESTINATION_RE, "]")
    .replace(LINK_REFERENCE_RE, "]")
    .replace(LABELLED_WIKILINK_RE, "$1")
    .replace(SPAN, (_, n: string) => spans[Number(n)]!);
}
