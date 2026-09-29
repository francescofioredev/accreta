import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DOCS, RESULTS } from "../lib/paths.ts";
import { splice, table } from "../lib/report-kit.ts";
import { fmtRate, percentile, rate } from "../lib/stats.ts";

const CARD = join(DOCS, "experiments", "t4-wiki-navigation.md");
const CLASSES = ["title", "paraphrase", "supersession"];
const ARMS = ["bm25", "jev-rerank", "haiku-rerank", "jev-nav"];

interface Row {
  id: string;
  class: string;
  relevant: string[];
  arm: string;
  ranking: string[];
  trace?: string[];
  calls: number;
  latency_ms: number;
  input_tokens: number;
  cost_usd: number;
  error?: string;
}

export function reportT4(): void {
  const scaleFile = join(RESULTS, "r-t4-rfc-kb-scale.json");
  if (existsSync(scaleFile)) {
    const s = JSON.parse(readFileSync(scaleFile, "utf8"));
    splice(
      CARD,
      "t4-scale",
      table(
        [
          "Pages",
          "Links",
          "Full rebuild (3 runs)",
          "Index size",
          "Search",
          "getPage",
          "findRelated",
          "lint",
          "Machine",
        ],
        [
          [
            s.pages,
            s.links,
            s.build_ms.map((m: number) => `${m} ms`).join(", "),
            `${(s.index_bytes / 1e6).toFixed(1)} MB`,
            `${s.search_ms} ms`,
            `${s.get_page_ms} ms`,
            `${s.find_related_ms} ms`,
            `${s.lint_ms} ms`,
            s.machine,
          ],
        ],
      ) +
        "\n\n5,908 of 9,842 pages (60.0%) have no supersession or update link in either direction. No index-free navigator can reach them from another page.",
    );
  }
  const rows: Row[] = readdirSync(RESULTS)
    .filter((f) => f.startsWith("r-t4-") && !f.includes("scale"))
    .flatMap((f) => JSON.parse(readFileSync(join(RESULTS, f), "utf8")).rows);
  if (!rows.length) return;
  const body: (string | number)[][] = [];
  for (const arm of ARMS) {
    for (const cls of CLASSES) {
      const rs = rows.filter((r) => r.arm === arm && r.class === cls);
      if (!rs.length) continue;
      const hit1 = rs.filter((r) => r.ranking[0] && r.relevant.includes(r.ranking[0])).length;
      const hit5 = rs.filter((r) =>
        r.ranking.slice(0, 5).some((p) => r.relevant.includes(p)),
      ).length;
      const lat = rs.map((r) => r.latency_ms).filter((x) => x > 0);
      const calls = rs.reduce((s, r) => s + r.calls, 0) / rs.length;
      body.push([
        arm,
        cls,
        fmtRate(rate(hit1, rs.length)),
        arm === "jev-nav" ? "—" : fmtRate(rate(hit5, rs.length)),
        calls ? calls.toFixed(2) : "0",
        lat.length
          ? `${Math.round(percentile(lat, 0.5))} / ${Math.round(percentile(lat, 0.95))} ms`
          : "—",
        calls
          ? `$${((rs.reduce((s, r) => s + r.cost_usd, 0) / rs.length) * 1000).toFixed(3)}`
          : "$0",
        rs.filter((r) => r.error).length,
      ]);
    }
  }
  splice(
    CARD,
    "t4-r",
    [
      "150 queries per class over the 9,842-page knowledge base. Navigation's latency is the sum over its hops.",
      "",
      table(
        [
          "Arm",
          "Class",
          "Recall@1",
          "Recall@5",
          "Model calls per query",
          "Latency per query p50 / p95",
          "Cost per 1,000 queries",
          "Errors",
        ],
        body,
      ),
    ].join("\n"),
  );
}
