import { existsSync } from "node:fs";
import { openIndex, type SourceAdapter } from "@accreta/core";
import { loadSources as loadDeclaredSources, type Preflight } from "@accreta/adapters";
import { findWorkspace, type Workspace } from "../workspace.ts";

export interface CommandContext {
  cwd: string;
  out: (line: string) => void;
  err: (line: string) => void;
}

/** Load every `sources/*.yaml` declaration in the workspace. */
export function loadSources(workspace: Workspace): SourceAdapter[] {
  return [
    ...loadDeclaredSources({
      root: workspace.root,
      citationFormat: workspace.config.provenanceFormat,
    }).values(),
  ];
}

export function withIndex<T>(
  ctx: CommandContext,
  fn: (db: ReturnType<typeof openIndex>, w: Workspace) => T,
): T {
  const workspace = findWorkspace(ctx.cwd);
  if (!existsSync(workspace.indexPath)) {
    throw new Error(`No index at ${workspace.indexPath}. Run \`accreta reindex\` first.`);
  }
  const db = openIndex(workspace.indexPath, { readonly: true });
  try {
    return fn(db, workspace);
  } finally {
    db.close();
  }
}

export function reportPreflight(ctx: CommandContext, preflight: Preflight, indent: string): void {
  const label = preflight.reachable === "yes" ? "ok" : preflight.reachable;
  ctx.out(`${indent}${label}: ${preflight.detail}`);
  if (preflight.remedy) ctx.out(`${indent}  → ${preflight.remedy}`);
  if (preflight.agentAccess) {
    ctx.out(`${indent}your agent needs: ${preflight.agentAccess.connector} — unverified`);
    ctx.out(`${indent}  → ${preflight.agentAccess.hint}`);
  }
}
