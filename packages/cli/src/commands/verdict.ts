import { existsSync } from "node:fs";
import { openIndex, planVerdict, writeVerdict } from "@accreta/core";
import { findWorkspace } from "../workspace.ts";
import { printable, printJson, type CommandContext } from "./shared.ts";

/** Record that a re-read citation does or does not back its sentence, in the verdict file. */
export async function verdict(
  ctx: CommandContext,
  args: { page?: string; footnote?: string; value?: string; model?: string; json?: boolean },
): Promise<number> {
  if (!args.page || !args.footnote || !args.value) {
    ctx.err("Usage: accreta verdict <page> <footnote> supported|unsupported --model <name>");
    return 2;
  }
  if (!args.model) {
    ctx.err("verdict needs --model: the model that re-read the citation (`human` if you did).");
    return 2;
  }
  const workspace = findWorkspace(ctx.cwd);
  if (!existsSync(workspace.indexPath)) {
    throw new Error(`No index at ${workspace.indexPath}. Run \`accreta reindex\` first.`);
  }
  const db = openIndex(workspace.indexPath, { readonly: true });
  try {
    const plan = planVerdict(db, workspace.config, {
      page: args.page,
      footnote: args.footnote,
      verdict: args.value,
      model: args.model,
      writer: "cli",
      date: new Date().toISOString().slice(0, 10),
    });
    if (!plan.ok) {
      ctx.err(printable(plan.message));
      return 1;
    }
    const file = writeVerdict(workspace.root, workspace.config, plan.line);
    if (args.json) printJson(ctx, { ok: true, verdict: plan.line });
    else {
      ctx.out(
        `Recorded ${plan.line.verdict} for [^${plan.line.footnote}] on ${printable(plan.line.page)} at ${printable(plan.line.revision)} (writer cli, model ${printable(plan.line.model)}, declared).`,
      );
      ctx.out(
        `Written to ${printable(file.slice(workspace.root.length + 1))}; commit it with the page.`,
      );
    }
    return 0;
  } finally {
    db.close();
  }
}
