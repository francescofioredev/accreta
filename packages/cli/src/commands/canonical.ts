import { findCanonical, findCanonicalPage, type CanonicalMatch } from "@accreta/core";
import {
  printJson,
  provenance,
  readPage,
  refuseCursor,
  reportPage,
  withIndex,
  type CommandContext,
  type PageFlags,
} from "./shared.ts";

const MATCH_FIELDS = [
  "results[].path",
  "results[].title",
  "results[].type",
  "results[].canonical_source",
] as const;

export function canonical(
  ctx: CommandContext,
  term: string,
  options: { json?: boolean } & PageFlags = {},
): number {
  if (!term) {
    ctx.err("Usage: accreta canonical <term> [--limit <n>] [--cursor <c>] [--json]");
    return 2;
  }
  const page = readPage(ctx, options);
  if (page === null) return 2;
  return withIndex(ctx, (db, workspace) => {
    let found: ReturnType<typeof findCanonicalPage>;
    try {
      if (page) {
        found = findCanonicalPage(db, term, workspace.config, page);
      } else {
        const results = findCanonical(db, term, workspace.config);
        found = { results, total: results.length };
      }
    } catch (error) {
      return refuseCursor(ctx, error);
    }
    const matches = found.results;
    if (options.json) {
      printJson(ctx, {
        count: found.total,
        results: matches.map(matchOut),
        nextCursor: found.nextCursor,
        _provenance: provenance(MATCH_FIELDS),
      });
      return 0;
    }
    if (found.total === 0) {
      ctx.out(`Nothing is canonical for "${term}".`);
      return 0;
    }
    for (const match of matches) {
      ctx.out(`${match.path}  [${match.type}]  (matched on ${match.matchedOn})`);
      if (match.canonicalSource) ctx.out(`  source: ${match.canonicalSource}`);
    }
    if (page) reportPage(ctx, matches.length, found.total, "match(es)", found.nextCursor);
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
