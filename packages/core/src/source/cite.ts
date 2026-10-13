import { compileCitationTemplate } from "../citations.ts";
import {
  DelegatedSourceError,
  UNPINNED_REVISION,
  formatCanonicalSource,
  formatCitation,
  parseCitation,
  unknownVerdict,
  type LocationVerdict,
  type ParsedCitation,
  type SourceAdapter,
} from "./adapter.ts";

/** A citation the agent can paste, and whether the place it names is really there. */
export interface Citation {
  /** The source's current revision, or the one the agent observed; null when neither is known. */
  revision: string | null;
  /** `agent` when the revision was transcribed from what the agent read, never checked by accreta. */
  revisionFrom: "source" | "agent" | null;
  location: LocationVerdict;
  /**
   * In `provenance.format`. A null revision renders `UNPINNED_REVISION`, flagged `citation-unpinned`:
   * for a delegated source cite again with `observedRevision`; for an uncommitted file commit first.
   */
  footnote: string;
  /** `source:path[#locator]`, the fixed grammar `parseCitation` reads. */
  canonicalSource: string;
  /** Set when the source is read through a connector only the agent holds. */
  delegated?: { via: string; guidance: string };
}

export interface CiteOptions {
  /**
   * The revision the agent read through a delegated source's connector; refused for any other.
   * The revision the cited content was read at, observed with that read, not after.
   */
  observedRevision?: string;
}

/**
 * Cite a place at the source's current revision, or a delegated one at the agent's observed one.
 * Never pins the shared adapter. Cite before reading and after: a later revision can name unread content.
 */
export async function cite(
  sources: ReadonlyMap<string, SourceAdapter>,
  format: string,
  target: ParsedCitation,
  options: CiteOptions = {},
): Promise<Citation> {
  const { sourceId, path } = target;
  const locator = target.locator || undefined;
  const adapter = sources.get(sourceId);
  if (!adapter) {
    const known = [...sources.keys()].toSorted().join(", ") || "none";
    throw new Error(`Unknown source "${sourceId}". Configured sources: ${known}.`);
  }
  if (path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error(`Path "${path}" is not canonical: it has an empty, "." or ".." segment`);
  }
  const { observedRevision } = options;
  if (observedRevision !== undefined) checkObserved(observedRevision, format);

  // Sequential so the revision is taken no later than the place it vouches for.
  const current = await currentRevision(adapter);
  if (typeof current === "string" && observedRevision !== undefined) {
    throw new Error(
      `Source "${sourceId}" reports its own revision; observedRevision is only for a delegated source`,
    );
  }
  const location = await adapter.locate(path, locator).catch(unknownVerdict);
  // accreta vouches for a revision only where it could check the place; one the agent transcribed
  // from a delegated source is pinned but marked as the agent's, and the place stays unknown.
  const checked = typeof current === "string" && location.verdict !== "unknown" ? current : null;
  const revision = checked ?? observedRevision ?? null;
  const revisionFrom = checked !== null ? "source" : revision !== null ? "agent" : null;

  const parts = { sourceId, path, ...(locator ? { locator } : {}) };
  const rev = revision ?? UNPINNED_REVISION;
  const canonicalSource = formatCanonicalSource(parts);
  const footnote = formatCitation(format, { source: sourceId, rev, path, locator });

  const canonicalMismatch = differingPart(parts, parseCitation(canonicalSource));
  if (canonicalMismatch) {
    throw new Error(
      `canonical_source "${canonicalSource}" does not read back: its ${canonicalMismatch} differs`,
    );
  }
  const template = compileCitationTemplate(format);
  if (!template.ok) throw new Error(template.reason);
  const read = template.template.read(footnote);
  // A format may leave out {rev} or {locator}, so the footnote cannot carry them; lint flags no {rev}.
  const shown = format.includes("{locator}") ? parts : { sourceId, path };
  const footnoteMismatch =
    differingPart(shown, read) ??
    (read?.revision != null && read.revision !== rev ? "revision" : null);
  if (footnoteMismatch) {
    throw new Error(
      `footnote "${footnote}" does not read back through provenance.format: its ${footnoteMismatch} differs`,
    );
  }

  const citation: Citation = { revision, revisionFrom, location, footnote, canonicalSource };
  if (current instanceof DelegatedSourceError) {
    citation.delegated = { via: current.via, guidance: current.guidance };
  }
  return citation;
}

// Widen deliberately when a real connector needs it.
const OBSERVED_REVISION = /^[A-Za-z0-9][A-Za-z0-9._:+/@-]{0,127}$/;

function checkObserved(observed: string, format: string): void {
  if (observed.trim() === "") throw new Error("observedRevision is empty");
  if (!OBSERVED_REVISION.test(observed)) {
    throw new Error(
      "observedRevision must start with a letter or digit and use only letters, digits and . _ : + / @ -, at most 128 characters",
    );
  }
  if (observed.toLowerCase() === UNPINNED_REVISION) {
    throw new Error(`observedRevision "${observed}" is the unpinned marker, not a revision`);
  }
  if (!format.includes("{rev}")) {
    throw new Error("observedRevision was given, but provenance.format cannot carry a revision");
  }
}

async function currentRevision(adapter: SourceAdapter): Promise<string | DelegatedSourceError> {
  let revision: unknown;
  try {
    revision = await adapter.revision();
  } catch (error) {
    // Declining is the source's answer, not a failure; anything else still is.
    if (error instanceof DelegatedSourceError) return error;
    throw error;
  }
  if (typeof revision !== "string" || revision === "") {
    throw new Error(`Source "${adapter.id}" reported no revision`);
  }
  return revision;
}

function differingPart(
  expected: ParsedCitation,
  actual: { sourceId: string; path: string; locator?: string } | null,
): string | null {
  if (!actual) return "whole citation";
  if (actual.sourceId !== expected.sourceId) return "source";
  if (actual.path !== expected.path) return "path";
  if (actual.locator !== expected.locator) return "locator";
  return null;
}
