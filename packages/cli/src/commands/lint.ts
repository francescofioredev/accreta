import { existsSync } from "node:fs";
import { isAdvisory, lintKnowledgeBase, openIndex } from "@accreta/core";
import { countUnchecked, unloadedFindings } from "@accreta/adapters";
import { findWorkspace } from "../workspace.ts";
import {
  DRIFT_NOTICE,
  loadSources,
  printable,
  printJson,
  provenance,
  readPage,
  refuseCursor,
  reportPage,
  type CommandContext,
  type PageFlags,
} from "./shared.ts";

const LINT_FIELDS = [
  "findings[].path",
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
  options: { json?: boolean } & PageFlags = {},
): Promise<number> {
  const page = readPage(ctx, options);
  if (page === null) return 2;
  const workspace = findWorkspace(ctx.cwd);
  if (!existsSync(workspace.indexPath)) {
    throw new Error(`No index at ${workspace.indexPath}. Run \`accreta reindex\` first.`);
  }

  const db = openIndex(workspace.indexPath, { readonly: true });
  try {
    const loaded = loadSources(workspace);
    const sources = new Map(loaded.sources.map((adapter) => [adapter.id, adapter]));
    // Without a page every finding prints, as before paging existed; with one, as MCP pages it.
    let report: Awaited<ReturnType<typeof lintKnowledgeBase>>;
    try {
      report = await lintKnowledgeBase(db, workspace.config, sources, {
        page,
        sourceFindings: unloadedFindings(countUnchecked(db, loaded.unloaded)),
      });
    } catch (error) {
      return refuseCursor(ctx, error);
    }
    const findings = report.findings;
    const advisory = report.advisoryCount ?? 0;
    const blocking = report.total - advisory;

    if (options.json) {
      printJson(ctx, {
        pages_checked: report.pagesChecked,
        count: report.total,
        citations_checked: report.citationsChecked,
        citations_unchecked: report.citationsUnchecked,
        unchecked_reasons: report.uncheckedReasons,
        advisory_count: advisory,
        findings: findings.map((f) => (isAdvisory(f.kind) ? { ...f, advisory: true } : f)),
        nextCursor: report.nextCursor,
        // An unloaded-source finding quotes sources/*.yaml.
        _provenance: provenance(LINT_FIELDS, DRIFT_NOTICE),
      });
      // The whole list, not this page: a later page must not read as a clean pass.
      return blocking > 0 ? 1 : 0;
    }

    // A count rather than findings: the citations belong to a source accreta
    // cannot question, and "I did not look" must not be printed as a problem
    // found. It is still the size of what this pass did not cover.
    const unchecked =
      report.citationsUnchecked > 0
        ? [
            `${report.citationsUnchecked} citation(s) could not be checked:`,
            ...report.uncheckedReasons.flatMap((r) => [
              `  ${r.citations}  ${printable(r.detail)}`,
              `       ${r.paths.slice(0, 5).map(printable).join(", ")}${r.paths.length > 5 ? `, +${r.paths.length - 5} more` : ""}`,
            ]),
          ].join("\n")
        : null;

    const checked = `${report.citationsChecked} citation(s) checked against their source.`;
    if (report.total === 0) {
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

    const printKinds = (advisoryKinds: boolean) => {
      for (const [kind, group] of byKind) {
        if (isAdvisory(group[0]!.kind) !== advisoryKinds) continue;
        // A page holds only some of each kind, so its count must not read as the kind's total.
        ctx.out(`\n${kind} (${group.length}${page ? " on this page" : ""})`);
        for (const finding of group)
          ctx.out(`  ${printable(finding.path)}: ${printable(finding.detail)}`);
      }
    };
    printKinds(false);
    if (advisory > 0) {
      ctx.out("\nadvisory (listed for review; they do not change the exit code)");
      printKinds(true);
    }
    ctx.out(
      blocking === 0
        ? `\n${report.pagesChecked} page(s) checked, nothing to fix; ${advisory} advisory finding(s).`
        : `\n${blocking} finding(s) across ${report.pagesChecked} page(s)${advisory > 0 ? `, and ${advisory} advisory` : ""}.`,
    );
    ctx.out(checked);
    if (unchecked) ctx.out(unchecked);
    if (page) reportPage(ctx, findings.length, report.total, "finding(s)", report.nextCursor);

    // A non-zero exit so CI can fail on an unresolvable link.
    return blocking > 0 ? 1 : 0;
  } finally {
    db.close();
  }
}
