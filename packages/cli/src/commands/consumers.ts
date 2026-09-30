import { findRelated, type Relation } from "@accreta/core";
import { printJson, provenance, withIndex, type CommandContext } from "./shared.ts";

// An outbound path is a wikilink target, so it is whatever the page wrote, file or not.
const RELATION_FIELDS = ["results[].path", "results[].type", "results[].title"] as const;

export function consumers(
  ctx: CommandContext,
  target: string,
  options: { includeInline?: boolean; kinds?: string[]; json?: boolean } = {},
): number {
  if (!target) {
    ctx.err("Usage: accreta consumers <path-or-wikilink> [--inline] [--kind <field>] [--json]");
    return 2;
  }
  return withIndex(ctx, (db, workspace) => {
    const result = findRelated(db, target, workspace.config, {
      kinds: options.kinds,
      includeInline: options.includeInline,
    });
    if (options.json) {
      printJson(ctx, {
        target: result.target,
        target_exists: result.targetExists,
        count: result.relations.length,
        results: result.relations.map(relationOut),
        _provenance: provenance(RELATION_FIELDS),
      });
      return 0;
    }
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

function relationOut(relation: Relation) {
  return {
    path: relation.path,
    kind: relation.kind,
    direction: relation.direction,
    type: relation.type,
    title: relation.title,
  };
}
