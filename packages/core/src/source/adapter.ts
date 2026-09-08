import { resolve, sep } from "node:path";

/**
 * A source is anything that can answer three questions: what revision are you
 * at, what changed since a given revision, and is this location really inside
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

  /**
   * Does a citation point at something that exists?
   *
   * The adapter owns what a locator means, and that is the whole reason this
   * method is here rather than the `read` it replaced. The core used to answer
   * this itself by reading the source and counting newlines, which quietly made
   * every source line-oriented: a page addressed by block id had no way to be
   * checked, and no way to say so.
   */
  locate(path: string, locator?: string): Promise<LocationVerdict>;

  /** Render a citation to a location, per the configured provenance format. */
  citation(path: string, locator?: string): string;

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
 * What a source can say about a citation's target.
 *
 * Three answers rather than two, for the reason `changedSince` distinguishes
 * "nothing changed" from "I cannot tell": a source accreta reaches only through
 * the agent can check nothing, and reporting that as `missing` would turn "I
 * did not look" into "I found something".
 */
export type LocationVerdict =
  | { verdict: "found" }
  | { verdict: "missing"; part: "path" | "locator"; detail: string }
  | { verdict: "unknown"; detail: string };

/**
 * What a citation names before anything has been pinned.
 *
 * Shared by every adapter so the honest answer cannot vary by source type. The
 * `fs` adapter shipped this sentinel while `git` shipped `"HEAD"`, which reads
 * as a real revision and so states something the source cannot support.
 */
export const UNPINNED_REVISION = "unknown";

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
 * Thrown when a source can only be reached by the agent, not by accreta.
 *
 * A value would have been the smaller change — a flag on the adapter, or a
 * sentinel revision — and both would have let a caller carry on as if an answer
 * had been given. The same reasoning as `UnknownRevisionError`: a condition that
 * must not be confused with an answer is raised, not returned.
 *
 * `guidance` is the source declaration's own description of what is in scope. It
 * is prose written by whoever declared the source, carried to whoever has to act
 * on it, and accreta neither interprets nor validates it.
 */
export class DelegatedSourceError extends Error {
  constructor(
    readonly sourceId: string,
    readonly via: string,
    readonly guidance: string,
  ) {
    super(`Source "${sourceId}" is read through ${via} by the agent, not by accreta`);
    this.name = "DelegatedSourceError";
  }
}

/**
 * Resolve a source-relative path, refusing one that climbs out of the root.
 *
 * The argument reaching `locate` is not always something the operator wrote. A
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

/**
 * Read a line-range locator such as `L142-L158`, or `L7` for a single line.
 *
 * Line ranges belong to the citation grammar rather than to any one adapter, so
 * the grammar owns them: two file-backed sources that read `L142-L158`
 * differently would make a citation mean different things depending on which
 * source it happened to name. Whether those lines exist is the adapter's
 * answer, and this function does not ask.
 *
 * Null for anything else, a descending or zero-based range included — those are
 * well-formed pointers at nothing, which is a finding rather than a parse
 * error.
 */
export function parseLineLocator(locator: string): readonly [start: number, end: number] | null {
  const match = locator.match(/^L(\d+)(?:-L?(\d+))?$/);
  if (!match) return null;

  const start = Number(match[1]);
  const end = match[2] === undefined ? start : Number(match[2]);
  if (start < 1 || end < start) return null;
  return [start, end];
}

/** A `canonical_source` pointer, split into the parts a check can act on. */
export interface ParsedCitation {
  sourceId: string;
  path: string;
  /**
   * Where inside the document, in whatever terms the source addresses itself.
   *
   * Opaque here on purpose. A file source reads `L142-L158`; a page source
   * reads something like `block-a1b2c3`. The core carries the string and the
   * adapter decides whether it means anything.
   */
  locator?: string;
}

/**
 * Read a `canonical_source` value back into its parts.
 *
 * This is deliberately *not* the inverse of `formatCitation`. That renders the
 * configured `provenance.format`, which is prose a human reads in a footnote
 * and which every knowledge base may shape differently. `canonical_source` is a
 * fixed machine-readable convention — `source:path[#locator]` — documented in
 * the constitution and in architecture.md, and it is the one a check can
 * resolve without knowing how a given knowledge base likes its citations to
 * read.
 *
 * Returns null rather than throwing: a value that does not parse is a finding
 * to report, not an exception to propagate out of a lint pass.
 */
export function parseCitation(value: string): ParsedCitation | null {
  const match = value.trim().match(/^([^\s:]+):([^\s#]+)(?:#(\S+))?$/);
  if (!match) return null;

  const [, sourceId, path, locator] = match;
  if (!sourceId || !path) return null;

  // A locator this parser cannot judge is still a well-formed pointer. Whether
  // it addresses anything is the adapter's answer, not the grammar's.
  return locator === undefined ? { sourceId, path } : { sourceId, path, locator };
}

/**
 * Render a citation from the configured template.
 *
 * The format is configuration because what a citation should look like depends
 * on what is being cited: a line range suits a file, a block id suits a page,
 * and a source with neither should not be forced to invent one. A `{locator}`
 * with no value is dropped along with the `#` that introduces it rather than
 * rendered as the literal string "undefined".
 */
export function formatCitation(
  format: string,
  parts: { source: string; rev: string; path: string; locator?: string },
): string {
  const { source, rev, path, locator } = parts;

  const out = format
    .replaceAll("{source}", source)
    .replaceAll("{rev}", rev)
    .replaceAll("{path}", path);

  if (locator) return out.replaceAll("{locator}", locator).trim();
  return out.replace(/#?\{locator\}/g, "").trim();
}
