import { findRelated } from "@accreta/core";
import { withIndex, type CommandContext } from "./shared.ts";

export function consumers(
  ctx: CommandContext,
  target: string,
  options: { includeInline?: boolean } = {},
): number {
  if (!target) {
    ctx.err("Usage: accreta consumers <path-or-wikilink> [--inline]");
    return 1;
  }
  return withIndex(ctx, (db, workspace) => {
    const result = findRelated(db, target, workspace.config, {
      includeInline: options.includeInline,
    });
    if (!result.targetExists) ctx.out(`(no page at ${result.target})`);
    if (result.relations.length === 0) {
      ctx.out(
        options.includeInline
          ? "No relations."
          : "No declared relations. Pass --inline to include inline [[mentions]].",
      );
      return 0;
    }
    for (const relation of result.relations) {
      const arrow = relation.direction === "inbound" ? "←" : "→";
      ctx.out(`${arrow} ${relation.path}  [${relation.kind}]  ${relation.title ?? ""}`);
    }
    ctx.out(`\n${result.relations.length} relation(s).`);
    return 0;
  });
}
