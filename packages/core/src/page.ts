import { parse as parseYaml } from "yaml";

export type Frontmatter = Record<string, unknown>;

export interface ParsedPage {
  frontmatter: Frontmatter;
  body: string;
  title: string;
}

/**
 * Frontmatter is the leading `---` fenced block. The trailing newline is
 * optional so that a page consisting of nothing but frontmatter still parses.
 */
const FRONTMATTER_RE = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/;

/**
 * A wikilink target: `[[path]]`, `[[path#anchor]]`, `[[path|label]]`.
 *
 * The target stops at `#` or `|` so that an anchor or a display label never
 * becomes part of the path. Both forms render on GitHub, so both appear in real
 * corpora.
 */
const WIKILINK_RE = /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g;

/**
 * Does this value read as a single flow sequence — one `[` that closes at the
 * very end — rather than as a wikilink or a scalar that merely begins with one?
 *
 * Wikilinks are treated as opaque here: `[[a]]` contributes nothing to the
 * depth, so `[[[a]], [[b]]]` is seen as `[ … ]` around two of them.
 */
function isFlowSequence(value: string): boolean {
  let depth = 0;
  for (let i = 0; i < value.length; i++) {
    // `[[[a]], …` opens a sequence *and* a wikilink at the same offset. The
    // outer bracket has to be counted first, so only treat this as a wikilink
    // when the next character is not itself another `[`.
    if (value.startsWith("[[", i) && value[i + 2] !== "[") {
      const close = value.indexOf("]]", i + 2);
      if (close === -1) return false;
      i = close + 1;
      continue;
    }
    const ch = value[i];
    if (ch === "[") depth++;
    else if (ch === "]") {
      depth--;
      if (depth === 0) return i === value.length - 1;
      if (depth < 0) return false;
    }
  }
  return false;
}

function quoteWikilinksInline(value: string): string {
  // `(?!\[)` keeps the outer bracket of `[[[a]], [[b]]]` out of the match. Without
  // it the regex starts at the sequence's own `[`, quotes it into the string, and
  // produces `"[[[a]]", …]` — a sequence with one bracket too few, which fails to
  // parse and silently drops the whole field.
  return value.replace(/\[\[(?!\[)([^\]]+)\]\]/g, (_, inner: string) => {
    return `"[[${inner.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}]]"`;
  });
}

/**
 * Make a frontmatter block loadable as YAML.
 *
 * `discussed_in: [[synthesis/energy-balance]]` is not valid YAML — the parser
 * reads `[[` as the start of a nested flow sequence and fails on the unclosed
 * bracket. Authors write it anyway, because that is the syntax that renders as a
 * link on GitHub, so the parser has to meet the corpus where it is: quote the
 * wikilinks into strings before handing the block to the YAML parser.
 *
 * Only lines containing `[[` are touched; everything else is passed through
 * untouched so that ordinary YAML keeps its ordinary meaning.
 */
function preprocessFrontmatter(yamlSource: string): string {
  const out: string[] = [];

  for (const line of yamlSource.split(/\r?\n/)) {
    if (!line.includes("[[")) {
      out.push(line);
      continue;
    }

    const kv = line.match(/^(\s*)([\w-]+)\s*:\s*(.*)$/);
    if (!kv) {
      // A bare list item (`  - [[target]]`) or a continuation line.
      out.push(quoteWikilinksInline(line));
      continue;
    }

    const [, indent = "", key = "", rawValue = ""] = kv;
    const value = rawValue.trim();

    // An explicit flow sequence: `key: [x, [[b]]]`, and also `key: [[[a]], [[b]]]`
    // whose first element happens to be a wikilink.
    //
    // Deciding this on the `[[` prefix is wrong and was wrong in the
    // implementation this was ported from: `[[[a]], [[b]]]` is a sequence that
    // opens with a wikilink, but it starts with `[[` and so was treated as a
    // bare scalar, leaving the outer bracket unclosed and dropping the field.
    // Balance the brackets across the whole value instead of guessing from its
    // first two characters.
    if (value.startsWith("[") && isFlowSequence(value)) {
      out.push(`${indent}${key}: ${quoteWikilinksInline(rawValue)}`);
      continue;
    }

    // `key: [[a]], [[b]]` — comma-separated wikilinks with no enclosing
    // brackets. YAML would read this as one scalar; the author meant a list.
    const items = value
      .split(/\s*,\s*/)
      .map((item) => item.trim())
      .filter(Boolean);
    if (items.length > 0 && items.every((item) => /^\[\[[^\]]+\]\]$/.test(item))) {
      const quoted = items.map((item) => `"${item}"`).join(", ");
      out.push(`${indent}${key}: [${quoted}]`);
      continue;
    }

    out.push(`${indent}${key}: ${quoteWikilinksInline(rawValue)}`);
  }

  return out.join("\n");
}

/**
 * Split a page into frontmatter, body and title.
 *
 * A page with no frontmatter, or with frontmatter that will not parse, is still
 * a page: it keeps its body and gets an empty frontmatter. Refusing to index it
 * would hide the one page most likely to need fixing.
 */
export function parsePage(raw: string, fallbackTitle: string): ParsedPage {
  const match = raw.match(FRONTMATTER_RE);
  let frontmatter: Frontmatter = {};
  let body = raw;

  if (match) {
    try {
      const loaded = parseYaml(preprocessFrontmatter(match[1] ?? ""));
      if (loaded && typeof loaded === "object" && !Array.isArray(loaded)) {
        frontmatter = loaded as Frontmatter;
      }
    } catch {
      frontmatter = {};
    }
    body = raw.slice(match[0].length);
  }

  const heading = body.match(/^#\s+(.+)$/m);
  const title =
    (typeof frontmatter.title === "string" && frontmatter.title.length > 0
      ? frontmatter.title
      : null) ??
    heading?.[1]?.trim() ??
    fallbackTitle;

  return { frontmatter, body, title };
}

export { WIKILINK_RE };
