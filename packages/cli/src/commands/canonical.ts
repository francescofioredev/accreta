import { findCanonical } from "@accreta/core";
import { withIndex, type CommandContext } from "./shared.ts";

export function canonical(ctx: CommandContext, term: string): number {
  if (!term) {
    ctx.err("Usage: accreta canonical <term>");
    return 1;
  }
  return withIndex(ctx, (db, workspace) => {
    const matches = findCanonical(db, term, workspace.config);
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
