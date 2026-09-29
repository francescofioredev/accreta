import { getPage } from "@accreta/core";
import { withIndex, type CommandContext } from "./shared.ts";

export function show(ctx: CommandContext, target: string): number {
  if (!target) {
    ctx.err("Usage: accreta show <path-or-wikilink>");
    return 1;
  }
  return withIndex(ctx, (db, workspace) => {
    const page = getPage(db, target, workspace.config);
    if (!page) {
      ctx.err(`No page matches "${target}".`);
      return 1;
    }
    ctx.out(`# ${page.title}`);
    ctx.out(`path: ${page.path}`);
    ctx.out(`type: ${page.type}`);
    if (page.canonicalSource) ctx.out(`canonical_source: ${page.canonicalSource}`);
    if (page.lastVerifiedRevision) ctx.out(`verified at: ${page.lastVerifiedRevision}`);
    ctx.out("");
    ctx.out(page.body.trim());
    return 0;
  });
}
