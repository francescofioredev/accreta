// Cost per page, resolving footnote, cited claim and supported claim, recomputed from recorded usage.
// bun bench/eval/cost.ts --sessions <file> --kb <dir> --at <rev> [--arm <id>] [--support-rate <0..1>]
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import type { Session } from "./lib/agent.ts";
import { kbAt } from "./lib/accreta.ts";
import { costReport, sessionsOfArm, type CostReport } from "./lib/cost.ts";
import { measurePages } from "./lib/pages.ts";

/** Counts come from the same page metrics H1 reads, at the same pin. */
export function measureCost(opts: {
  sessions: string;
  kb: string;
  at: string;
  arm?: string;
  supportRate?: number;
}): CostReport {
  const { sessions } = JSON.parse(readFileSync(opts.sessions, "utf-8")) as { sessions: Session[] };
  const m = measurePages(kbAt(opts.kb), opts.at);
  return costReport(sessionsOfArm(sessions, opts.arm), {
    pages: m.pages,
    resolvingFootnotes: m.citations.byStatus.resolves,
    citedClaims: m.claims.cited.k,
    ...(opts.supportRate === undefined ? {} : { supportRate: opts.supportRate }),
  });
}

if (import.meta.main) {
  const { values: v } = parseArgs({
    options: {
      sessions: { type: "string" },
      kb: { type: "string" },
      at: { type: "string" },
      arm: { type: "string" },
      "support-rate": { type: "string" },
    },
  });
  if (!v.sessions || !v.kb || !v.at) {
    console.error(
      "usage: cost.ts --sessions <file> --kb <dir> --at <rev> [--arm <id>] [--support-rate <0..1>]",
    );
    process.exit(2);
  }
  const rate = v["support-rate"];
  const report = measureCost({
    sessions: v.sessions,
    kb: v.kb,
    at: v.at,
    arm: v.arm,
    supportRate: rate === undefined ? undefined : Number(rate),
  });
  console.log(JSON.stringify(report, null, 2));
}
