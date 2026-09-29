import { getPage, searchPages, type SearchHit } from "@accreta/core";
import { parseLimit, printJson, provenance, withIndex, type CommandContext } from "./shared.ts";

// search_pages refuses a limit above this rather than letting the core clamp it silently.
const MAX_LIMIT = 50;

const HIT_FIELDS = ["results[].title", "results[].snippet", "results[].matched_aliases"] as const;

export interface SearchOptions {
  types?: string[];
  source?: string;
  limit?: string;
  json?: boolean;
}

export function search(ctx: CommandContext, query: string, options: SearchOptions = {}): number {
  if (!query) {
    ctx.err("Usage: accreta search <query> [--type <type>] [--source <id>] [--limit <n>] [--json]");
    return 2;
  }
  const limit = parseLimit(options.limit, MAX_LIMIT);
  if (limit === null) {
    ctx.err(`--limit takes a whole number from 1 to ${MAX_LIMIT}.`);
    return 2;
  }
  return withIndex(ctx, (db, workspace) => {
    const hits = searchPages(db, { query, types: options.types, source: options.source, limit });

    if (options.json) {
      const results = hits.map((hit) => {
        const page = getPage(db, hit.path, workspace.config);
        return hitOut(hit, page ? matchedAliasesOf(query, page.frontmatter) : []);
      });
      printJson(ctx, { count: hits.length, results, _provenance: provenance(HIT_FIELDS) });
      return 0;
    }

    if (hits.length === 0) {
      ctx.out("No matches.");
      return 0;
    }
    for (const hit of hits) {
      ctx.out(`${hit.path}  [${hit.type}]`);
      ctx.out(`  ${hit.title}`);
      ctx.out(`  ${hit.snippet.replace(/\s+/g, " ").trim()}`);
    }
    ctx.out(`\n${hits.length} result(s).`);
    return 0;
  });
}

function hitOut(hit: SearchHit, matchedAliases: string[]) {
  return {
    path: hit.path,
    type: hit.type,
    title: hit.title,
    source: hit.source,
    snippet: hit.snippet,
    last_verified_revision: hit.lastVerifiedRevision,
    ...(matchedAliases.length > 0 ? { matched_aliases: matchedAliases } : {}),
  };
}

/** The aliases that plausibly explain a hit; the same approximation of FTS5 stemming as MCP's. */
function matchedAliasesOf(query: string, frontmatter: Record<string, unknown>): string[] {
  const raw = frontmatter.aliases;
  const aliases =
    typeof raw === "string"
      ? [raw]
      : Array.isArray(raw)
        ? raw.filter((a) => typeof a === "string")
        : [];
  if (aliases.length === 0) return [];

  const terms = query
    .toLowerCase()
    .replace(/["*()]/g, " ")
    .split(/\s+/)
    .filter((term) => term.length > 0 && !["and", "or", "not", "near"].includes(term));

  return aliases.filter((alias) => {
    const text = alias.toLowerCase();
    return terms.some((term) => text.includes(term));
  });
}
