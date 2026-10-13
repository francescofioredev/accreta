import { cite as citeAt, parseCitation } from "@accreta/core";
import { findWorkspace } from "../workspace.ts";
import { loadSources, printJson, provenance, type CommandContext } from "./shared.ts";

const CITE_FIELDS = ["location.detail"] as const;

export async function cite(
  ctx: CommandContext,
  raw: string,
  options: { json?: boolean; expectRevision?: string } = {},
): Promise<number> {
  const target = parseCitation(raw);
  if (!target) {
    ctx.err(
      raw
        ? `"${raw}" is not source:path[#locator]; a path with "#" or whitespace in it cannot be cited.`
        : "Usage: accreta cite <source>:<path>[#locator] [--expect-revision <rev>] [--json]",
    );
    return 2;
  }

  // No index: a citation asks the source, never the pages.
  const workspace = findWorkspace(ctx.cwd);
  const loaded = loadSources(workspace);
  const broken = loaded.unloaded.find((u) => u.id === target.sourceId);
  if (broken) {
    throw new Error(
      `Source "${target.sourceId}" is declared in ${broken.file} but did not load: ${broken.reason}`,
    );
  }
  const sources = new Map(loaded.sources.map((adapter) => [adapter.id, adapter]));
  // Input errors exit 2, not 1 like a refusal; the sentences are core's, which MCP returns.
  if (!sources.has(target.sourceId)) {
    const known = [...sources.keys()].toSorted().join(", ") || "none";
    ctx.err(`Unknown source "${target.sourceId}". Configured sources: ${known}.`);
    return 2;
  }
  if (target.path.split("/").some((part) => part === "" || part === "." || part === "..")) {
    ctx.err(`Path "${target.path}" is not canonical: it has an empty, "." or ".." segment`);
    return 2;
  }

  const citation = await citeAt(sources, workspace.config.provenanceFormat, target);
  const expected = options.expectRevision;
  if (expected !== undefined && citation.revision !== expected) {
    throw new Error(
      citation.revision !== null
        ? `Source "${target.sourceId}" is at ${citation.revision}, not ${expected}: it moved since you read it, or ${expected} did not come from cite. Re-read ${citation.canonicalSource}, then cite again.`
        : citation.delegated
          ? `Cannot confirm source "${target.sourceId}" is still at ${expected}: it is read through ${citation.delegated.via}, and accreta cannot tell its revision.`
          : `Cannot confirm source "${target.sourceId}" is still at ${expected}: accreta could not check this place. Cite it without an expected revision to see why.`,
    );
  }
  // A place that is not there must not look like a citation to paste.
  const code = citation.location.verdict === "missing" ? 1 : 0;

  if (options.json) {
    printJson(ctx, {
      canonical_source: citation.canonicalSource,
      footnote: citation.footnote,
      revision: citation.revision,
      location: citation.location,
      ...(citation.delegated
        ? { delegated: { via: citation.delegated.via, scope: citation.delegated.guidance } }
        : {}),
      _provenance: provenance(CITE_FIELDS),
    });
    return code;
  }

  const { location } = citation;
  // Missing leads with why and prints no footnote, so `| head -1` never yields one to paste.
  if (location.verdict === "missing") {
    ctx.out(`location: missing ${location.part}: ${location.detail}`);
  } else {
    ctx.out(citation.footnote);
  }
  ctx.out(`canonical_source: ${citation.canonicalSource}`);
  ctx.out(`revision: ${citation.revision ?? "none, so the footnote is unpinned"}`);
  if (location.verdict !== "missing") {
    ctx.out(
      location.verdict === "found" ? "location: found" : `location: unknown: ${location.detail}`,
    );
  }
  if (citation.delegated) {
    ctx.out(`delegated: read through ${citation.delegated.via}; scope:`);
    ctx.out(citation.delegated.guidance.trimEnd());
  }
  return code;
}
