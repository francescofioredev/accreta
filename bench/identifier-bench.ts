#!/usr/bin/env bun
/**
 * Measure plain search on underscore-joined identifiers (#275) against judgments written before any run.
 * `--verbose` prints every query's ranking.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildIndex, openIndex, parseConfig, searchPages } from "@accreta/core";

const DIR = join(dirname(fileURLToPath(import.meta.url)), "identifiers");

interface Query {
  id: string;
  class: string;
  query: string;
  relevant: string[];
}

const config = parseConfig(readFileSync(join(DIR, "accreta.config.yaml"), "utf-8"));
const indexPath = join(DIR, ".accreta", "index.sqlite");
buildIndex({ root: DIR, config, indexPath });
const db = openIndex(indexPath, { readonly: true });
const { queries } = JSON.parse(readFileSync(join(DIR, "queries.json"), "utf-8")) as {
  queries: Query[];
};

const rows = queries.map((q) => {
  const hits = searchPages(db, { query: q.query, limit: 10 }).map((h) =>
    h.path.replace(/^knowledge\//, ""),
  );
  const first = hits.findIndex((h) => q.relevant.includes(h));
  const found = q.relevant.filter((r) => hits.includes(r)).length;
  return { ...q, hits, rank: first === -1 ? null : first + 1, recall: found / q.relevant.length };
});
db.close();

const summary = (subset: typeof rows) => {
  const n = subset.length;
  return {
    n,
    recall1: subset.filter((r) => r.rank === 1).length / n,
    mrr: subset.reduce((s, r) => s + (r.rank ? 1 / r.rank : 0), 0) / n,
    recall10: subset.reduce((s, r) => s + r.recall, 0) / n,
    empty: subset.filter((r) => r.hits.length === 0).length,
  };
};
const line = (label: string, m: ReturnType<typeof summary>) =>
  `  ${label.padEnd(10)} n=${String(m.n).padEnd(3)} recall@1 ${(m.recall1 * 100).toFixed(0).padStart(3)}%   MRR ${m.mrr.toFixed(3)}   recall@10 ${(m.recall10 * 100).toFixed(0).padStart(3)}%   empty ${m.empty}`;

console.log(`identifier queries: ${rows.length}`);
console.log(line("all", summary(rows)));
for (const cls of [...new Set(rows.map((r) => r.class))]) {
  console.log(line(cls, summary(rows.filter((r) => r.class === cls))));
}
const nearMiss = rows.find((r) => r.id === "i02");
if (nearMiss) console.log(`\n"${nearMiss.query}" rank 1: ${nearMiss.hits[0] ?? "(none)"}`);

if (process.argv.includes("--verbose")) {
  console.log();
  for (const r of rows) {
    console.log(
      `  ${r.id} ${r.query.padEnd(24)} rank ${String(r.rank ?? "-").padEnd(2)} ${r.hits.join(", ") || "(none)"}`,
    );
  }
}
