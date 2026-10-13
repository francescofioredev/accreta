// Score `accreta drift --json` against git ground truth, per citation and per page.
// Usage: bun bench/eval/drift-score.ts --kb <dir> [--to <rev>] [--citations]
import { parseArgs } from "node:util";
import { accretaJson, kbAt, readIndex, reindex, type Kb } from "./lib/accreta.ts";
import { scoreDrift, type DriftJson, type DriftScore } from "./lib/drift-match.ts";
import { driftTruth } from "./lib/drift-truth.ts";
import { checkTarget, declaredSources } from "./lib/sources.ts";

export function measureDrift(kb: Kb, to?: string): DriftScore & { heads: Record<string, string> } {
  const heads = checkTarget(kb, to);
  reindex(kb);
  const { pages, footnotes } = readIndex(kb);
  const truth = driftTruth(pages, footnotes, declaredSources(kb.root));
  return { heads, ...scoreDrift(truth, accretaJson<DriftJson>(kb, "drift", "--json")) };
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      kb: { type: "string" },
      to: { type: "string" },
      citations: { type: "boolean", default: false },
    },
  });
  if (!values.kb) {
    console.error("usage: drift-score.ts --kb <dir> [--to <rev>] [--citations]");
    process.exit(2);
  }
  const { citations, ...score } = measureDrift(kbAt(values.kb), values.to);
  // The false positives and negatives are always listed: they are what a reader checks by hand.
  const errors = citations.filter((c) => (c.status === "changed") !== (c.prediction === "flagged"));
  console.log(
    JSON.stringify({ ...score, errors, ...(values.citations ? { citations } : {}) }, null, 2),
  );
}
