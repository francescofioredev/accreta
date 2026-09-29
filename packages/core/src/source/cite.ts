import {
  DelegatedSourceError,
  UNPINNED_REVISION,
  formatCitation,
  unknownVerdict,
  type LocationVerdict,
  type ParsedCitation,
  type SourceAdapter,
} from "./adapter.ts";

/** A citation the agent can paste, and whether the place it names is really there. */
export interface Citation {
  /** The source's current revision, or null when accreta cannot ask the source. */
  revision: string | null;
  location: LocationVerdict;
  /** Rendered in `provenance.format`; names `UNPINNED_REVISION` when `revision` is null. */
  footnote: string;
  /** `source:path[#locator]`, the fixed grammar `parseCitation` reads. */
  canonicalSource: string;
  /** Set when the source is read through a connector only the agent holds. */
  delegated?: { via: string; guidance: string };
}

/**
 * Cite a place in a source at its current revision. Never pins: a lookup must not change what
 * an ingest already pinned will cite, so the footnote is rendered here with `formatCitation`.
 */
export async function cite(
  sources: ReadonlyMap<string, SourceAdapter>,
  format: string,
  target: ParsedCitation,
): Promise<Citation> {
  const { sourceId, path, locator } = target;
  const adapter = sources.get(sourceId);
  if (!adapter) {
    const known = [...sources.keys()].toSorted().join(", ") || "none";
    throw new Error(`Unknown source "${sourceId}". Configured sources: ${known}.`);
  }

  const [current, location] = await Promise.all([
    currentRevision(adapter),
    adapter.locate(path, locator).catch(unknownVerdict),
  ]);
  const revision = typeof current === "string" ? current : null;

  const citation: Citation = {
    revision,
    location,
    footnote: formatCitation(format, {
      source: sourceId,
      rev: revision ?? UNPINNED_REVISION,
      path,
      locator,
    }),
    canonicalSource: locator ? `${sourceId}:${path}#${locator}` : `${sourceId}:${path}`,
  };
  if (current instanceof DelegatedSourceError) {
    citation.delegated = { via: current.via, guidance: current.guidance };
  }
  return citation;
}

async function currentRevision(adapter: SourceAdapter): Promise<string | DelegatedSourceError> {
  try {
    return await adapter.revision();
  } catch (error) {
    // Declining is the source's answer, not a failure; anything else still is.
    if (error instanceof DelegatedSourceError) return error;
    throw error;
  }
}
