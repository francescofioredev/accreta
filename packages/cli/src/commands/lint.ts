import { existsSync } from "node:fs";
import { lintKnowledgeBase, openIndex } from "@accreta/core";
import { countUnchecked, unloadedFindings } from "@accreta/adapters";
import { findWorkspace } from "../workspace.ts";
import { loadSources, printJson, provenance, type CommandContext } from "./shared.ts";

const LINT_FIELDS = [
  "findings[].detail",
  "unchecked_reasons[].detail",
  "unchecked_reasons[].paths",
] as const;

// Opens and closes the index itself rather than going through `withIndex`:
// citation checks read from the sources, and `withIndex` closes the database in
// a synchronous `finally` that would fire before the first await resolved.
// `drift` has the same shape for the same reason.
export async function runLint(
  ctx: CommandContext,
  options: { json?: boolean } = {},
): Promise<number> {
  const workspace = findWorkspace(ctx.cwd);
  if (!existsSync(workspace.indexPath)) {
    throw new Error(`No index at ${workspace.indexPath}. Run \`accreta reindex\` first.`);
  }

  const db = openIndex(workspace.indexPath, { readonly: true });
  try {
    const loaded = loadSources(workspace);
    const sources = new Map(loaded.sources.map((adapter) => [adapter.id, adapter]));
    // No page: the CLI prints every finding. The MCP tool pages the same list.
    const report = await lintKnowledgeBase(db, workspace.config, sources, {
      sourceFindings: unloadedFindings(countUnchecked(db, loaded.unloaded)),
    });
    const findings = report.findings;

    if (options.json) {
      printJson(ctx, {
        pages_checked: report.pagesChecked,
        count: findings.length,
        citations_checked: report.citationsChecked,
        citations_unchecked: report.citationsUnchecked,
        unchecked_reasons: report.uncheckedReasons,
        findings,
        _provenance: provenance(LINT_FIELDS),
      });
      return findings.length > 0 ? 1 : 0;
    }

    // A count rather than findings: the citations belong to a source accreta
    // cannot question, and "I did not look" must not be printed as a problem
    // found. It is still the size of what this pass did not cover.
    const unchecked =
      report.citationsUnchecked > 0
        ? [
            `${report.citationsUnchecked} citation(s) could not be checked:`,
            ...report.uncheckedReasons.flatMap((r) => [
              `  ${r.citations}  ${r.detail}`,
              `       ${r.paths.slice(0, 5).join(", ")}${r.paths.length > 5 ? `, +${r.paths.length - 5} more` : ""}`,
            ]),
          ].join("\n")
        : null;

    const checked = `${report.citationsChecked} citation(s) checked against their source.`;
    if (findings.length === 0) {
      ctx.out(`${report.pagesChecked} page(s) checked, nothing to report.`);
      ctx.out(checked);
      if (unchecked) ctx.out(unchecked);
      return 0;
    }

    const byKind = new Map<string, typeof findings>();
    for (const finding of findings) {
      const list = byKind.get(finding.kind);
      if (list) list.push(finding);
      else byKind.set(finding.kind, [finding]);
    }

    for (const [kind, group] of byKind) {
      ctx.out(`\n${kind} (${group.length})`);
      for (const finding of group) ctx.out(`  ${finding.path}: ${finding.detail}`);
    }
    ctx.out(`\n${findings.length} finding(s) across ${report.pagesChecked} page(s).`);
    ctx.out(checked);
    if (unchecked) ctx.out(unchecked);

    // A non-zero exit so CI can fail on an unresolvable link.
    return 1;
  } finally {
    db.close();
  }
}
