// Cost per page and per valid citation, recomputed from recorded usage.
// bun bench/eval/cost.ts --sessions <file with {sessions: [...]}> --kb <dir>
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import type { Session } from "./lib/agent.ts";
import { kbAt } from "./lib/accreta.ts";
import { costReport, type CostReport } from "./lib/cost.ts";
import { measurePages } from "./lib/pages.ts";

/** A valid citation is one lint resolves: the same count the 95% gate reads. */
export function measureCost(sessionsFile: string, kbRoot: string): CostReport {
  const { sessions } = JSON.parse(readFileSync(sessionsFile, "utf-8")) as { sessions: Session[] };
  const pages = measurePages(kbAt(kbRoot));
  return costReport(sessions, pages.pages, pages.citations.byStatus.resolves);
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: { sessions: { type: "string" }, kb: { type: "string" } },
  });
  if (!values.sessions || !values.kb) {
    console.error("usage: cost.ts --sessions <file> --kb <dir>");
    process.exit(2);
  }
  console.log(JSON.stringify(measureCost(values.sessions, values.kb), null, 2));
}
