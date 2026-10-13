import { nameKey } from "./name-key.ts";

// Footnotes are prose rendered from `provenance.format`, which each knowledge base shapes
// its own way (ADR-0011), so they are read by inverting that template, not by imposing one.

export interface CitationParts {
  sourceId: string;
  /** Null when the format has no `{rev}`, so a footnote cannot name one. */
  revision: string | null;
  path: string;
  locator?: string;
}

export interface CitationTemplate {
  /** The parts of a footnote written in this format, or null if it is not. */
  read(text: string): CitationParts | null;
  /**
   * Whether a footnote is meant as a citation: it carries the format's literals, or names a path
   * with a locator (`path#locator`), as one in an earlier format does. Prose is not a broken citation.
   */
  attempts(text: string): boolean;
}

export type TemplateResult =
  { ok: true; template: CitationTemplate } | { ok: false; reason: string };

export const PLACEHOLDER_RE = /(\{source\}|\{rev\}|\{path\}|\{locator\})/;

const CAPTURE: Record<string, string> = {
  source: "\\S+?",
  rev: "\\S+?",
  // `#` introduces the locator in the default format, so a path stops before it.
  path: "[^\\s#]+?",
  locator: "\\S+?",
};

// A whitespace-delimited `path#locator`; `scheme:`, `[` and `(` keep URLs and links out, and a
// numeric locator is an issue reference. A separator needs a word after it, so dots scan linearly.
const POINTER_RE = /(?:^|\s)[\w./@+~-]+#(?!\d+\b)\w+(?:[.:-]+\w+)*[.,;:!?)]*(?=\s|$)/;

function escapeLiteral(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
}

/**
 * Compile `provenance.format` into a reader for the footnotes it renders, or say why it would
 * have to guess: adjacent placeholders cannot be split, and without `{source}` and `{path}` a
 * footnote names nothing. `#{locator}` is optional because `formatCitation` drops it.
 */
export function compileCitationTemplate(format: string): TemplateResult {
  // The retired `L{start}-L{end}` rendered exactly what `{locator}` renders for a line range.
  const current = format.replace("L{start}-L{end}", "{locator}");
  if (/\{start\}|\{end\}/.test(current)) {
    return {
      ok: false,
      reason: `provenance.format "${format}" uses the retired {start} and {end}; replace them with {locator}`,
    };
  }
  const tokens = current.trim().split(PLACEHOLDER_RE);
  const names = tokens.filter((_, i) => i % 2 === 1).map((t) => t.slice(1, -1));

  for (const required of ["source", "path"]) {
    if (!names.includes(required)) {
      return {
        ok: false,
        reason: `provenance.format "${format}" has no {${required}}, so a footnote cannot say what it cites`,
      };
    }
  }

  let pattern = "";
  const markers: string[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < tokens.length; i++) {
    let token = tokens[i] ?? "";
    if (i % 2 === 0) {
      if (i > 0 && i < tokens.length - 1 && token === "") {
        return {
          ok: false,
          reason: `provenance.format "${format}" puts ${tokens[i - 1]} and ${tokens[i + 1]} side by side, so a footnote cannot be split between them`,
        };
      }
      // A `#` right before `{locator}` goes with it: both vanish when there is no locator.
      if (tokens[i + 1] === "{locator}" && token.endsWith("#")) token = token.slice(0, -1);
      pattern += escapeLiteral(token);
      if (token.trim()) markers.push(...token.trim().split(/\s+/));
      continue;
    }

    const name = token.slice(1, -1);
    if (seen.has(name)) {
      pattern += `\\k<${name}>`;
      continue;
    }
    seen.add(name);
    const capture = `(?<${name}>${CAPTURE[name]})`;
    pattern +=
      name === "locator"
        ? (tokens[i - 1] ?? "").endsWith("#")
          ? `(?:#${capture})?`
          : `(?:${capture})?`
        : capture;
  }

  const re = new RegExp(`^\\s*${pattern}\\s*$`);

  return {
    ok: true,
    template: {
      read(text) {
        const groups = text.match(re)?.groups;
        if (!groups?.source || !groups.path) return null;
        const parts: CitationParts = {
          sourceId: groups.source,
          revision: groups.rev ?? null,
          path: groups.path,
        };
        return groups.locator ? { ...parts, locator: groups.locator } : parts;
      },
      attempts: (text) => markers.every((marker) => text.includes(marker)) || POINTER_RE.test(text),
    },
  };
}

export interface Footnote {
  /** The id between `[^` and `]`. */
  id: string;
  /** 1-based line of the definition, in the text it was read from. */
  line: number;
  /** The definition, after `[^id]:`. */
  text: string;
  /** The sentences that reference it, one per line, footnote markers removed. */
  claim: string;
}

/** A footnote that cannot pair up: a reference nothing defines, or a definition no claim leads to. */
export interface FootnoteOrphan {
  id: string;
  /** 1-based line of the reference or definition, in the text it was read from. */
  line: number;
  role: "reference" | "definition";
}

const DEFINITION_RE = /^\[\^([^\]\s]+)\]:\s*(.*?)\s*$/;
const FENCE_RE = /^\s*(```|~~~)/;
const REFERENCE_RE = /(?<!\\)\[\^([^\]\s]+)\](?!:)/g;
const INLINE_CODE_RE = /(`+).*?\1/g;
// Stands in for the `[` of a marker inside inline code, so the code survives into the claim.
const MASKED = "\0";

/** How footnote ids are paired: GFM folds labels, so `[^A]` cites `[^a]`. */
export const footnoteKey = nameKey;

/**
 * Every footnote definition in a page body, with the claim that cites it. A claim is the
 * sentence carrying the marker, since a paragraph makes several; fenced code is an example.
 */
export function extractFootnotes(body: string): Footnote[] {
  return readFootnotes(body).footnotes;
}

/**
 * `extractFootnotes`, plus the footnotes that do not pair up. A definition counts as referenced
 * only if a claim in the body leads to it, directly or through other definitions.
 */
export function readFootnotes(body: string): { footnotes: Footnote[]; orphans: FootnoteOrphan[] } {
  if (!body.includes("[^")) return { footnotes: [], orphans: [] };
  const lines = body.split("\n");
  const definitions: Omit<Footnote, "claim">[] = [];
  const references: { id: string; line: number; within: string | null; raw: string }[] = [];
  const prose: string[] = [];
  let fenced = false;
  let within: string | null = null;
  let afterBlank = false;

  lines.forEach((line, index) => {
    if (FENCE_RE.test(line)) {
      fenced = !fenced;
      within = null;
      afterBlank = false;
      prose.push("");
      return;
    }
    if (fenced) {
      prose.push("");
      return;
    }
    const masked = line.replace(INLINE_CODE_RE, (code) => code.replaceAll("[^", `${MASKED}^`));
    const definition = line.match(DEFINITION_RE);
    if (definition) {
      within = footnoteKey(definition[1]!);
      definitions.push({ id: definition[1]!, line: index + 1, text: definition[2]! });
      prose.push("");
    } else {
      // A definition runs on, lazily or indented, until a blank line and an unindented one, as on GitHub.
      if (afterBlank && /^\S/.test(line)) within = null;
      prose.push(within === null ? masked : "");
    }
    afterBlank = line.trim() === "";
    for (const match of masked.matchAll(REFERENCE_RE)) {
      references.push({ id: footnoteKey(match[1]!), line: index + 1, within, raw: match[1]! });
    }
  });

  const claims = new Map<string, string[]>();
  for (const paragraph of prose.join("\n").split(/\n\s*\n/)) {
    if (!paragraph.includes("[^")) continue;
    for (const sentence of sentences(paragraph.replace(/\s+/g, " ").trim())) {
      const ids = [...sentence.matchAll(REFERENCE_RE)].map((m) => footnoteKey(m[1]!));
      if (ids.length === 0) continue;
      const text = sentence.replace(REFERENCE_RE, "").trim().replaceAll(MASKED, "[");
      for (const id of new Set(ids)) {
        const list = claims.get(id);
        if (list) list.push(text);
        else claims.set(id, [text]);
      }
    }
  }

  const cites = new Map<string | null, string[]>();
  for (const { id, within: from } of references) {
    const list = cites.get(from);
    if (list) list.push(id);
    else cites.set(from, [id]);
  }
  const reached = new Set<string>();
  const queue = [...(cites.get(null) ?? [])];
  for (let id = queue.pop(); id !== undefined; id = queue.pop()) {
    if (reached.has(id)) continue;
    reached.add(id);
    queue.push(...(cites.get(id) ?? []));
  }
  const defined = new Set(definitions.map((d) => footnoteKey(d.id)));
  const orphans: FootnoteOrphan[] = [
    ...references
      .filter((r) => !defined.has(r.id))
      .map((r) => ({ id: r.raw, line: r.line, role: "reference" as const })),
    ...definitions
      .filter((d) => !reached.has(footnoteKey(d.id)))
      .map((d) => ({ id: d.id, line: d.line, role: "definition" as const })),
  ];

  return {
    footnotes: definitions.map((d) => ({
      ...d,
      claim: (claims.get(footnoteKey(d.id)) ?? []).join("\n"),
    })),
    orphans,
  };
}

// Markers usually follow the full stop, so a sentence can end on one. A capture group rather
// than a lookbehind: the lookbehind was 40x slower, and this runs on every reindex.
const SENTENCE_END_RE = /([.!?](?:\[\^[^\]\s]+\])*)\s+(?=[A-Z`*"(])/;

function sentences(paragraph: string): string[] {
  const parts = paragraph.split(SENTENCE_END_RE);
  const out: string[] = [];
  for (let i = 0; i < parts.length; i += 2) out.push(parts[i]! + (parts[i + 1] ?? ""));
  return out;
}
