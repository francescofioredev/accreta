import { parse as parseYaml } from "yaml";

export type Frontmatter = Record<string, unknown>;

export interface ParsedPage {
  frontmatter: Frontmatter;
  body: string;
  title: string;
  /**
   * Why the frontmatter is empty, when it is empty because it would not load.
   *
   * Absent for a page that simply declares nothing. The distinction is the
   * whole point: without it, a page whose frontmatter was discarded looks
   * exactly like a page that never had any, and `lint` can only report the
   * symptoms — no type, no provenance, no verified revision — while the author
   * stares at the fields that are plainly right there.
   */
  frontmatterError?: string;
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

/**
 * Whether the value is a single-quoted YAML scalar, as opposed to a plain one
 * that merely contains an apostrophe.
 *
 * The difference decides whether the value needs touching at all: YAML gives
 * `[` no meaning inside a single-quoted scalar, so `'see [[a/b]]'` already
 * loads as written. What separates the two is what follows the closing quote —
 * nothing, or a comment. `'a' and 'b' [[x]]` has prose after it, so it is a
 * plain scalar that happens to contain quotes.
 */
function isSingleQuotedScalar(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length < 2 || !trimmed.startsWith("'")) return false;

  let index = 1;
  while (index < trimmed.length) {
    if (trimmed[index] === "'") {
      // `''` is YAML's escape for a literal apostrophe; it does not close.
      if (trimmed[index + 1] === "'") {
        index += 2;
        continue;
      }
      const rest = trimmed.slice(index + 1).trim();
      return rest === "" || rest.startsWith("#");
    }
    index++;
  }
  // Unterminated: not a quoted scalar. Leave it to the scanner below.
  return false;
}

/**
 * Split a plain scalar from a trailing YAML comment.
 *
 * `#` opens a comment only when whitespace precedes it, so `a#b` is part of the
 * value while `a #b` is not. Getting this wrong is the reason the whole-value
 * quoting below was not attempted sooner: quoting `see [[a/b]] # note` entire
 * would swallow the comment into the title, trading a cosmetic bug for a
 * data-losing one.
 */
function splitTrailingComment(value: string): [scalar: string, comment: string] {
  for (let index = 0; index < value.length; index++) {
    if (value[index] !== "#") continue;
    const before = value[index - 1];
    if (index === 0 || before === " " || before === "\t") {
      return [value.slice(0, index).trimEnd(), value.slice(index)];
    }
  }
  return [value, ""];
}

function quoteWikilinksInline(value: string): string {
  let out = "";
  let index = 0;
  let insideQuotedScalar = false;

  while (index < value.length) {
    const char = value[index] as string;

    // A value the author already double-quoted is valid YAML exactly as written,
    // and quoting a wikilink inside one produces `"a "[[x]]" b"` — unbalanced
    // quotes, a parse error, and `parsePage` discarding *every* frontmatter key
    // rather than the one field. So track the quoted runs and leave them alone.
    // Link extraction does not suffer: `collectTargets` matches wikilinks inside
    // string values, so one left quoted is still found.
    //
    // Only double quotes. YAML gives no special meaning to a `'` inside a
    // double-quoted scalar or a plain one, so tracking single quotes would let
    // an apostrophe in `title: it's [[a/b]] here` open a run that never closes
    // and swallow the wikilink — breaking a shape that works today.
    //
    // A single-quoted *scalar* is handled before this runs, by
    // `isSingleQuotedScalar`. That test needs to know where the value begins,
    // which this scanner does not — it is handed a value already split from its
    // key, and by then the two cases are indistinguishable to it.
    if (insideQuotedScalar) {
      // A backslash escape carries its next character with it, so an escaped
      // `\"` does not end the run.
      if (char === "\\" && index + 1 < value.length) {
        out += char + value[index + 1];
        index += 2;
        continue;
      }
      if (char === '"') insideQuotedScalar = false;
      out += char;
      index++;
      continue;
    }

    if (char === '"') {
      insideQuotedScalar = true;
      out += char;
      index++;
      continue;
    }

    // `value[index + 2] !== "["` keeps the outer bracket of `[[[a]], [[b]]]` out
    // of the match. Without it the scan starts at the sequence's own `[`, quotes
    // it into the string, and produces `"[[[a]]", …]` — a sequence with one
    // bracket too few, which fails to parse and silently drops the whole field.
    if (value.startsWith("[[", index) && value[index + 2] !== "[") {
      const close = value.indexOf("]]", index + 2);
      if (close !== -1) {
        const inner = value.slice(index + 2, close);
        out += `"[[${inner.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}]]"`;
        index = close + 2;
        continue;
      }
    }

    out += char;
    index++;
  }

  return out;
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

    // A single-quoted scalar is already valid YAML with `[[` inside it, so
    // quoting the wikilink only injects literal `"` into the author's text —
    // and where the scalar holds an unescaped apostrophe, breaks the block and
    // discards every key in it.
    if (isSingleQuotedScalar(rawValue)) {
      out.push(`${indent}${key}: ${rawValue}`);
      continue;
    }

    // A plain scalar containing a wikilink is quoted whole rather than around
    // the `[[…]]` alone. Both make the YAML load; only this one keeps the text
    // the author wrote, and the value is what `show`, `search` and the exact
    // title match in `find_canonical` all serve back.
    const [scalar, comment] = splitTrailingComment(rawValue);
    if (scalar.includes("[[") && !scalar.includes('"')) {
      const quoted = `"${scalar.replace(/\\/g, "\\\\")}"`;
      out.push(`${indent}${key}: ${quoted}${comment ? ` ${comment}` : ""}`);
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
  let frontmatterError: string | undefined;
  let body = raw;

  if (match) {
    try {
      const loaded = parseYaml(preprocessFrontmatter(match[1] ?? ""));
      if (loaded && typeof loaded === "object" && !Array.isArray(loaded)) {
        frontmatter = loaded as Frontmatter;
      } else if (loaded !== null && loaded !== undefined) {
        // A fence that parses to a scalar or a sequence is the quieter of the
        // two failures: nothing throws, and the page simply arrives with no
        // fields. Recorded rather than ignored, for the same reason as below.
        frontmatterError = `frontmatter is ${Array.isArray(loaded) ? "a list" : "a scalar"}, not a set of fields`;
      }
    } catch (error) {
      frontmatter = {};
      // First line only, with the parser's trailing "…:" dropped: the rest of
      // its message is a source excerpt that reads as noise once the finding
      // already names the page.
      const message = error instanceof Error ? (error.message.split("\n")[0] ?? "") : String(error);
      frontmatterError = message.replace(/:\s*$/, "");
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

  return { frontmatter, body, title, ...(frontmatterError ? { frontmatterError } : {}) };
}

export { WIKILINK_RE };
