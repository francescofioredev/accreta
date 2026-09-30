import { findCanonical, type CanonicalMatch } from "@accreta/core";
import { printJson, provenance, withIndex, type CommandContext } from "./shared.ts";

const MATCH_FIELDS = [
  "results[].path",
  "results[].title",
  "results[].type",
  "results[].canonical_source",
] as const;

export function canonical(
  ctx: CommandContext,
  term: string,
  options: { json?: boolean } = {},
): number {
  if (!term) {
    ctx.err("Usage: accreta canonical <term> [--json]");
    return 2;
  }
  return withIndex(ctx, (db, workspace) => {
    const matches = findCanonical(db, term, workspace.config);
    if (options.json) {
      printJson(ctx, {
        count: matches.length,
        results: matches.map(matchOut),
        _provenance: provenance(MATCH_FIELDS),
      });
      return 0;
    }
    if (matches.length === 0) {
      ctx.out(`Nothing is canonical for "${term}".`);
      return 0;
    }
    for (const match of matches) {
      ctx.out(`${match.path}  [${match.type}]  (matched on ${match.matchedOn})`);
      if (match.canonicalSource) ctx.out(`  source: ${match.canonicalSource}`);
    }
    return 0;
  });
}

function matchOut(match: CanonicalMatch) {
  return {
    path: match.path,
    title: match.title,
    type: match.type,
    canonical_source: match.canonicalSource,
    matched_on: match.matchedOn,
  };
}
