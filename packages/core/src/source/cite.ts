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
  /** The source's current revision; null when the source could not check the place. */
  revision: string | null;
  location: LocationVerdict;
  /**
   * Rendered in `provenance.format`. With a null revision it names `UNPINNED_REVISION`, which lint
   * flags `citation-unpinned` until the agent substitutes the revision it read through the connector.
   */
  footnote: string;
  /** `source:path[#locator]`, the fixed grammar `parseCitation` reads. */
  canonicalSource: string;
  /** Set when the source is read through a connector only the agent holds. */
  delegated?: { via: string; guidance: string };
}

/**
 * Cite a place at the source's current revision; never pins, as adapters are shared. Call it before
 * reading the source, or again after and compare: a later revision can name content never read.
 */
export async function cite(
  sources: ReadonlyMap<string, SourceAdapter>,
  format: string,
  target: ParsedCitation,
): Promise<Citation> {
  const { sourceId, path } = target;
  const locator = target.locator || undefined;
  const adapter = sources.get(sourceId);
  if (!adapter) {
    const known = [...sources.keys()].toSorted().join(", ") || "none";
    throw new Error(`Unknown source "${sourceId}". Configured sources: ${known}.`);
  }
  if (path.split("/").some((segment) => segment === "." || segment === "..")) {
    throw new Error(`Path "${path}" is not canonical: it has a "." or ".." segment`);
  }

  // Sequential so the revision is taken no later than the place it vouches for.
  const current = await currentRevision(adapter);
  const location = await adapter.locate(path, locator).catch(unknownVerdict);
  // accreta vouches for a revision only where it could check the place.
  const revision = typeof current === "string" && location.verdict !== "unknown" ? current : null;

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
  // A format may leave out {rev} or {locator}; the footnote then cannot carry them, by choice.
  const shown = format.includes("{locator}") ? parts : { sourceId, path };
  const footnoteMismatch =
    differingPart(shown, read) ??
    (read?.revision != null && read.revision !== rev ? "revision" : null);
  if (footnoteMismatch) {
    throw new Error(
      `footnote "${footnote}" does not read back through provenance.format: its ${footnoteMismatch} differs`,
    );
  }

  const citation: Citation = { revision, location, footnote, canonicalSource };
  if (current instanceof DelegatedSourceError) {
    citation.delegated = { via: current.via, guidance: current.guidance };
  }
  return citation;
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
