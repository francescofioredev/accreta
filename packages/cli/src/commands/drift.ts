import { existsSync } from "node:fs";
import { detectDrift, openIndex } from "@accreta/core";
import { findWorkspace } from "../workspace.ts";
import { loadSources, type CommandContext } from "./shared.ts";

export async function drift(
  ctx: CommandContext,
  options: { strict?: boolean } = {},
): Promise<number> {
  const workspace = findWorkspace(ctx.cwd);
  if (!existsSync(workspace.indexPath)) {
    throw new Error(`No index at ${workspace.indexPath}. Run \`accreta reindex\` first.`);
  }

  const sources = loadSources(workspace);
  if (sources.length === 0) {
    ctx.out("No sources declared in sources/. Nothing to check.");
    return 0;
  }

  const db = openIndex(workspace.indexPath, { readonly: true });
  let exitCode = 0;
  try {
    for (const adapter of sources) {
      const report = await detectDrift(db, adapter);

      // A source only the agent can reach produces a work order rather than a
      // verdict, so it is printed on its own terms and skips the outcomes below
      // — every one of which would imply somebody had looked.
      if (report.delegated) {
        const work = report.delegated;
        const pageCount = work.pending.reduce((total, entry) => total + entry.pages.length, 0);
        ctx.out(`${adapter.id} — read through ${work.via} by the agent, not by accreta`);

        if (pageCount > 0) {
          ctx.out(`  ${pageCount} page(s) for the agent to re-verify there:`);
          for (const entry of work.pending) {
            for (const path of entry.pages) {
              ctx.out(`    ${path} (verified at ${entry.revision})`);
            }
          }
        } else {
          ctx.out("  no pages cite it yet");
        }
        if (report.unverifiable.length > 0) {
          ctx.out(`  ${report.unverifiable.length} page(s) record no revision at all`);
        }
        ctx.out("  in scope:");
        for (const line of work.guidance.trim().split("\n")) ctx.out(`    ${line}`);

        if (options.strict && (pageCount > 0 || report.unverifiable.length > 0)) exitCode = 1;
        continue;
      }

      ctx.out(`${adapter.id} @ ${report.currentRevision}`);

      if (report.stale.length > 0) {
        // Summed over the groups rather than taken from `report.stale.length`,
        // which counts revisions now that the report is grouped. The reader is
        // being told how many pages are in doubt.
        const pageCount = report.stale.reduce((total, entry) => total + entry.pages.length, 0);
        ctx.out(`  ${pageCount} page(s) may have drifted:`);
        for (const entry of report.stale) {
          for (const path of entry.pages) {
            ctx.out(`    ${path} (verified at ${entry.revision})`);
          }
        }
        exitCode = 1;
      }
      // Reported separately because "I cannot tell" is not "out of date", and
      // collapsing them would misrepresent what the system actually knows.
      if (report.unresolvable.length > 0) {
        ctx.out(`  ${report.unresolvable.length} revision(s) this source cannot place:`);
        for (const entry of report.unresolvable) {
          ctx.out(`    ${entry.revision} — ${entry.pages.length} page(s)`);
        }
        exitCode = 1;
      }
      if (report.unverifiable.length > 0) {
        ctx.out(`  ${report.unverifiable.length} page(s) record no revision at all`);
        if (options.strict) exitCode = 1;
      }
      if (report.stale.length === 0 && report.unresolvable.length === 0) {
        ctx.out("  up to date");
      }
    }
  } finally {
    db.close();
  }
  return exitCode;
}
