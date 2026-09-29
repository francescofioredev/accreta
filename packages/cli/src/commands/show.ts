import { getPage, type PageRecord } from "@accreta/core";
import { printJson, provenance, withIndex, type CommandContext } from "./shared.ts";

const PAGE_FIELDS = ["page.title", "page.frontmatter", "page.body"] as const;

export function show(
  ctx: CommandContext,
  target: string,
  options: { json?: boolean } = {},
): number {
  if (!target) {
    ctx.err("Usage: accreta show <path-or-wikilink> [--json]");
    return 1;
  }
  return withIndex(ctx, (db, workspace) => {
    const page = getPage(db, target, workspace.config);
    if (options.json) {
      printJson(
        ctx,
        page
          ? { found: true, page: pageOut(page), _provenance: provenance(PAGE_FIELDS) }
          : { found: false, message: `No page matches "${target}".` },
      );
      return page ? 0 : 1;
    }
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

function pageOut(page: PageRecord) {
  return {
    path: page.path,
    type: page.type,
    title: page.title,
    source: page.source,
    canonical_source: page.canonicalSource,
    last_verified_revision: page.lastVerifiedRevision,
    frontmatter: page.frontmatter,
    body: page.body,
  };
}
