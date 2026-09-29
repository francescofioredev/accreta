import { buildIndex } from "@accreta/core";
import { findWorkspace } from "../workspace.ts";
import type { CommandContext } from "./shared.ts";

export function reindex(ctx: CommandContext): number {
  const workspace = findWorkspace(ctx.cwd);
  const result = buildIndex({
    root: workspace.root,
    config: workspace.config,
    indexPath: workspace.indexPath,
  });

  ctx.out(
    `Indexed ${result.pages} page${result.pages === 1 ? "" : "s"} ` +
      `and ${result.links} link${result.links === 1 ? "" : "s"} in ${result.ms.toFixed(0)}ms.`,
  );
  if (result.brokenLinks > 0) {
    // Surfaced here rather than left for `lint`, because a rebuild is when
    // someone is looking.
    ctx.out(`${result.brokenLinks} link(s) did not resolve. Run \`accreta lint\` for detail.`);
  }
  return 0;
}
