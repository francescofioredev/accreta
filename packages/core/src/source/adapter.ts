/**
 * A source is anything that can answer three questions: what revision are you
 * at, what changed since a given revision, and how do I cite a location inside
 * you.
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
}

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
