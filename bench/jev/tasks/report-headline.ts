import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DATA, DOCS, RESULTS } from "../lib/paths.ts";
import { splice, table } from "../lib/report-kit.ts";
import { auroc, pct, percentile } from "../lib/stats.ts";

const load = (f: string) =>
  existsSync(join(RESULTS, f)) ? JSON.parse(readFileSync(join(RESULTS, f), "utf8")) : null;
const auc = (rows: { p: number; y: boolean }[]) =>
  rows.length
    ? auroc(
        rows.map((r) => r.p),
        rows.map((r) => r.y),
      ).toFixed(2)
    : "—";

/** The README's summary table: one row per question, every figure recomputed from results/. */
export function reportHeadline(): void {
  const lines: (string | number)[][] = [];
  const t3 = [
    ...(load("r-t3-jev+jev-repeat.json")?.rows ?? []),
    ...(load("r-t3-haiku.json")?.rows ?? []),
    ...(load("r-t3-deterministic.json")?.rows ?? []),
  ].filter((r: any) => r.sample === 0 && r.split === "test" && r.p !== null);
  const opusT3 = new Map(
    (load("r-t3-annotator.json")?.rows ?? [])
      .filter((r: any) => r.annotator !== "unsure")
      .map((r: any) => [r.id, r.annotator === "technical"]),
  );
  const pick = (arm: string, ref: "ietf" | "opus") =>
    t3
      .filter((r: any) => r.arm === arm && (ref === "ietf" || opusT3.has(r.id)))
      .map((r: any) => ({
        p: r.p,
        y: ref === "ietf" ? r.label === "technical" : (opusT3.get(r.id) as boolean),
      }));
  lines.push([
    "Drift, RFC errata: did the correction change the meaning?",
    "AUROC vs IETF label",
    auc(pick("normative-regex", "ietf")),
    auc(pick("jev", "ietf")),
    auc(pick("haiku", "ietf")),
  ]);
  lines.push([
    "",
    "AUROC vs frontier annotator",
    auc(pick("normative-regex", "opus")),
    auc(pick("jev", "opus")),
    auc(pick("haiku", "opus")),
  ]);
  const l3 = load("r-t3-ladder-l3.json")?.rows ?? [];
  const opusL3 = new Map(
    (load("r-t3-annotator-l3.json")?.rows ?? [])
      .filter((r: any) => r.annotator !== "unsure")
      .map((r: any) => [r.id, r.annotator === "invalidated"]),
  );
  const l3p = (arm: string) =>
    l3
      .filter((r: any) => r.arm === arm && r.p !== null && opusL3.has(r.id))
      .map((r: any) => ({ p: r.p, y: opusL3.get(r.id) as boolean }));
  lines.push([
    "Drift, claims over errata: is the claim still true?",
    "AUROC vs frontier annotator",
    "—",
    auc(l3p("jev")),
    auc(l3p("haiku")),
  ]);
  const got = [
    ...(load("r-t3-got-jev.json")?.rows ?? []),
    ...(load("r-t3-got-haiku+opus.json")?.rows ?? []),
  ];
  const opusGot = new Map(
    got
      .filter((r: any) => r.arm === "opus" && (r.value === "invalidated" || r.value === "valid"))
      .map((r: any) => [r.id, r.value === "invalidated"]),
  );
  const gp = (arm: string) =>
    got
      .filter((r: any) => r.arm === arm && typeof r.value === "number" && opusGot.has(r.id))
      .map((r: any) => ({ p: r.value, y: opusGot.get(r.id) as boolean }));
  const items = existsSync(join(DATA, "t3-got.json"))
    ? JSON.parse(readFileSync(join(DATA, "t3-got.json"), "utf8")).items
    : [];
  const touched = items.filter((i: any) => i.touched).length;
  lines.push([
    "Drift, claims over code (got v13 → v14.4)",
    "citations left after hunk ∩ range (free)",
    `${touched} of ${items.length} (${pct(touched / items.length, 0)})`,
    "",
    "",
  ]);
  lines.push(["", "AUROC on those, vs frontier annotator", "—", auc(gp("jev")), auc(gp("haiku"))]);
  const sf = (arm: string) => {
    const r =
      load(`r-t2-scifact-${arm}.json`)?.rows.filter((x: any) => x.split === "test" && x.choice) ??
      [];
    return r.length ? pct(r.filter((x: any) => x.choice === x.label).length / r.length) : "—";
  };
  lines.push([
    "Citation support, SciFact (expert labels)",
    "accuracy, three labels",
    "—",
    sf("jev"),
    sf("haiku"),
  ]);
  const t4 = [
    ...(load("r-t4-bm25.json")?.rows ?? []),
    ...(load("r-t4-jev-nav+jev-rerank.json")?.rows ?? []),
    ...(load("r-t4-haiku-rerank.json")?.rows ?? []),
  ];
  const r1 = (arm: string, cls: string) => {
    const rs = t4.filter((r: any) => r.arm === arm && r.class === cls);
    return rs.length
      ? pct(rs.filter((r: any) => r.relevant.includes(r.ranking[0])).length / rs.length, 0)
      : "—";
  };
  for (const cls of ["paraphrase", "supersession"])
    lines.push([
      `Retrieval, ${cls} queries (9,842 pages)`,
      "recall@1: BM25, then BM25 top 20 reranked in one call",
      r1("bm25", cls),
      r1("jev-rerank", cls),
      r1("haiku-rerank", cls),
    ]);
  lines.push([
    "",
    "recall@1: BM25, then following typed links from its top hit",
    r1("bm25", "supersession"),
    r1("jev-nav", "supersession"),
    "—",
  ]);
  const lat = (f: string) => {
    const rs = (load(f)?.rows ?? []).map((r: any) => r.latency_ms).filter((x: number) => x > 0);
    return rs.length ? `${Math.round(percentile(rs, 0.5))} ms` : "—";
  };
  lines.push([
    "Latency per decision, p50 (errata)",
    "",
    "0 ms",
    lat("r-t3-jev+jev-repeat.json"),
    `${lat("r-t3-haiku.json")} (CLI)`,
  ]);
  splice(
    join(DOCS, "README.md"),
    "headline",
    table(["Question", "Measure", "Deterministic / baseline", "Jev", "Claude Haiku 4.5"], lines),
  );
}
