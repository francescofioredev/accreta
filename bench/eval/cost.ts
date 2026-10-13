// Cost per page and per valid citation, recomputed from recorded usage.
// bun bench/eval/cost.ts --sessions <file with {sessions: [...]}> --kb <dir> --at <rev> [--support-rate <0..1>]
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import type { Session } from "./lib/agent.ts";
import { kbAt } from "./lib/accreta.ts";
import { costReport, type CostReport } from "./lib/cost.ts";
import { measurePages } from "./lib/pages.ts";

/** Counts come from the same page metrics H1 reads, at the same pin. */
export function measureCost(
  sessionsFile: string,
  kbRoot: string,
  at: string,
  supportRate?: number,
): CostReport {
  const { sessions } = JSON.parse(readFileSync(sessionsFile, "utf-8")) as { sessions: Session[] };
  const m = measurePages(kbAt(kbRoot), at);
  return costReport(sessions, {
    pages: m.pages,
    resolvingFootnotes: m.citations.byStatus.resolves,
    citedClaims: m.claims.cited.k,
    ...(supportRate === undefined ? {} : { supportRate }),
  });
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      sessions: { type: "string" },
      kb: { type: "string" },
      at: { type: "string" },
      "support-rate": { type: "string" },
    },
  });
  if (!values.sessions || !values.kb || !values.at) {
    console.error("usage: cost.ts --sessions <file> --kb <dir> --at <rev> [--support-rate <0..1>]");
    process.exit(2);
  }
  const rate = values["support-rate"];
  const report = measureCost(
    values.sessions,
    values.kb,
    values.at,
    rate ? Number(rate) : undefined,
  );
  console.log(JSON.stringify(report, null, 2));
}
