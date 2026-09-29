import { searchPages } from "@accreta/core";
import { withIndex, type CommandContext } from "./shared.ts";

export function search(ctx: CommandContext, query: string, types?: string[]): number {
  if (!query) {
    ctx.err("Usage: accreta search <query> [--type <type>]");
    return 1;
  }
  return withIndex(ctx, (db) => {
    const hits = searchPages(db, { query, types });
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
