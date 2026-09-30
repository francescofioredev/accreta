import { findRelated, type Relation } from "@accreta/core";
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

// An outbound path is a wikilink target, so it is whatever the page wrote, file or not.
const RELATION_FIELDS = ["results[].path", "results[].type", "results[].title"] as const;

export function consumers(
  ctx: CommandContext,
  target: string,
  options: { includeInline?: boolean; kinds?: string[]; json?: boolean } & PageFlags = {},
): number {
  if (!target) {
    ctx.err(
      "Usage: accreta consumers <path-or-wikilink> [--inline] [--kind <field>] [--limit <n>] [--cursor <c>] [--json]",
    );
    return 2;
  }
  const page = readPage(ctx, options);
  if (page === null) return 2;
  return withIndex(ctx, (db, workspace) => {
    let result: ReturnType<typeof findRelated>;
    try {
      result = findRelated(db, target, workspace.config, {
        kinds: options.kinds,
        includeInline: options.includeInline,
        page,
      });
    } catch (error) {
      return refuseCursor(ctx, error);
    }
    if (options.json) {
      printJson(ctx, {
        target: result.target,
        target_exists: result.targetExists,
        count: result.total,
        results: result.relations.map(relationOut),
        nextCursor: result.nextCursor,
        _provenance: provenance(RELATION_FIELDS),
      });
      return 0;
    }
    if (!result.targetExists) ctx.out(`(no page at ${result.target})`);
    if (result.total === 0) {
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
    if (!page) {
      ctx.out(`\n${result.total} relation(s).`);
      return 0;
    }
    reportPage(ctx, result.relations.length, result.total, "relation(s)", result.nextCursor);
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
