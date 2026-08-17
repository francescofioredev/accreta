import { resolve, sep } from "node:path";

/**
 * A source is anything that can answer three questions: what revision are you
 * at, what changed since a given revision, and how do I cite a location inside
 * you — plus one instruction: cite against *this* revision.
 *
 * Git answers with a commit SHA and `diff --name-only`. A directory of
 * documents answers with a hash of modification times and a scan. An API might
 * answer with an ETag and a changes feed.
 *
 * Nothing in `packages/core` may branch on which implementation it holds. An
 * `if (adapter.id === "fs")` in the core means this interface is missing
 * something: extend the interface, do not special-case the caller.
 */
export interface SourceAdapter {
  /** Stable identifier used in citations and in page frontmatter. */
  readonly id: string;

  /** The revision the source is currently at. Opaque to the core. */
  revision(): Promise<string>;

  /**
   * Paths that changed between `revision` and now.
   *
   * Returning every path is a valid answer for a source that cannot compute a
   * difference — it is less useful, not incorrect. Throwing `UnknownRevision`
   * is the right answer when the revision is not one this source can reason
   * about, so drift detection can report "cannot tell" rather than "nothing
   * changed", which are very different claims.
   */
  changedSince(revision: string): Promise<string[]>;

  /** Read a path relative to the source root. */
  read(path: string): Promise<string>;

  /** Render a citation to a location, per the configured provenance format. */
  citation(path: string, lines?: LineRange): string;

  /**
   * Fix the revision that subsequent citations name.
   *
   * A citation must name the revision the claim was verified against, not
   * whatever the source happens to be at when the page is rendered later —
   * that is the difference between provenance and a guess. Only the caller
   * knows which revision a claim was checked against, so only the caller can
   * say.
   *
   * This is the interface's one mutator, and it is here rather than as a
   * parameter on `citation` because pinning happens once per ingest while
   * citations are rendered many times inside it.
   *
   * An adapter that has not been pinned must render `UNPINNED_REVISION` rather
   * than inventing a plausible-looking revision: a citation that reads as true
   * while naming nothing is worse than one that admits it knows nothing.
   */
  pinRevision(revision: string): void;
}

/**
 * What a citation names before anything has been pinned.
 *
 * Shared by every adapter so the honest answer cannot vary by source type. The
 * `fs` adapter shipped this sentinel while `git` shipped `"HEAD"`, which reads
 * as a real revision and so states something the source cannot support.
 */
export const UNPINNED_REVISION = "unknown";

export type LineRange = readonly [start: number, end: number];

/**
 * Thrown when a source is asked what changed since a revision it cannot place.
 *
 * Distinguishing this from an empty result is the difference between "nothing
 * changed" and "I cannot tell", and drift detection that conflates the two
 * reports pages as verified when it has no idea whether they are.
 */
export class UnknownRevisionError extends Error {
  constructor(
    readonly sourceId: string,
    readonly revision: string,
  ) {
    super(`Source "${sourceId}" cannot resolve revision "${revision}"`);
    this.name = "UnknownRevisionError";
  }
}

/**
 * Resolve a source-relative path, refusing one that climbs out of the root.
 *
 * The argument reaching `read` is not always something the operator wrote. A
 * `canonical_source` is authored by a model into a markdown file and handed
 * straight to this function by the citation checks, so a path that escapes the
 * root turns "verify this citation" into "read this file". `join` alone does
 * not stop it: `join(root, "../x")` is a path outside the root, and reading it
 * succeeds whenever something happens to be there.
 *
 * Shared by every adapter so the answer cannot vary by source type — an
 * adapter that confined its reads and one that did not would make the guarantee
 * depend on which source a page happened to cite.
 */
export function resolveInside(root: string, path: string): string {
  const full = resolve(root, path);
  const base = resolve(root);
  if (full !== base && !full.startsWith(base + sep)) {
    throw new Error(`Path "${path}" resolves outside the source root`);
  }
  return full;
}

/** A `canonical_source` pointer, split into the parts a check can act on. */
export interface ParsedCitation {
  sourceId: string;
  path: string;
  lines?: LineRange;
}

/**
 * Read a `canonical_source` value back into its parts.
 *
 * This is deliberately *not* the inverse of `formatCitation`. That renders the
 * configured `provenance.format`, which is prose a human reads in a footnote
 * and which every knowledge base may shape differently. `canonical_source` is a
 * fixed machine-readable convention — `source:path#Lstart[-Lend]` — documented
 * in the constitution and in architecture.md, and it is the one a check can
 * resolve without knowing how a given knowledge base likes its citations to
 * read.
 *
 * Returns null rather than throwing: a value that does not parse is a finding
 * to report, not an exception to propagate out of a lint pass.
 */
export function parseCitation(value: string): ParsedCitation | null {
  const match = value.trim().match(/^([^\s:]+):([^\s#]+?)(?:#L(\d+)(?:-L?(\d+))?)?$/);
  if (!match) return null;

  const [, sourceId, path, start, end] = match;
  if (!sourceId || !path) return null;

  if (start === undefined) return { sourceId, path };

  const from = Number(start);
  const to = end === undefined ? from : Number(end);
  // A descending range is a malformed pointer, not a range to check.
  if (from < 1 || to < from) return null;

  return { sourceId, path, lines: [from, to] };
}

/**
 * Render a citation from the configured template.
 *
 * The format is configuration because what a citation should look like depends
 * on what is being cited: a line range suits a file, and a source without line
 * numbers should not be forced to invent them. Placeholders that have no value
 * are dropped along with their surrounding `#L…-L…` decoration rather than
 * rendered as the literal string "undefined".
 */
export function formatCitation(
  format: string,
  parts: { source: string; rev: string; path: string; lines?: LineRange },
): string {
  const { source, rev, path, lines } = parts;

  let out = format
    .replaceAll("{source}", source)
    .replaceAll("{rev}", rev)
    .replaceAll("{path}", path);

  if (lines) {
    out = out.replaceAll("{start}", String(lines[0])).replaceAll("{end}", String(lines[1]));
  } else {
    // Strip a trailing line-range decoration such as `#L{start}-L{end}` rather
    // than leaving half a template behind.
    out = out.replace(/#?L?\{start\}\s*-\s*L?\{end\}/g, "").replace(/#$/, "");
  }

  return out.trim();
}
