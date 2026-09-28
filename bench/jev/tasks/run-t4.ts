#!/usr/bin/env bun
/** T4 tier R: BM25, Jev rerank, Jev navigation; Haiku rerank as the LLM baseline. */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { haiku } from "../lib/haiku.ts";
import { jev } from "../lib/jev.ts";
import { DATA, RESULTS } from "../lib/paths.ts";
import { pool } from "../lib/pool.ts";
import type { Decision } from "../lib/questions.ts";
import { bm25, hopCall, openKb, PROTOCOL, rerankCall } from "./t4-nav.ts";

interface Query {
  id: string;
  class: string;
  query: string;
  relevant: string[];
}
const arms = new Set(
  (
    process.argv.find((a) => a.startsWith("--arms="))?.slice(7) ??
    "bm25,jev-rerank,jev-nav,haiku-rerank"
  ).split(","),
);
const { queries } = JSON.parse(readFileSync(join(DATA, "t4-queries.json"), "utf8")) as {
  queries: Query[];
};
const { db, config } = openKb();
const rows: object[] = [];
const base = (q: Query) => ({ id: q.id, class: q.class, relevant: q.relevant });

const candidates = new Map(
  queries.map((q) => [q.id, bm25(db, q.query, PROTOCOL.rerank_candidates)]),
);
if (arms.has("bm25"))
  for (const q of queries)
    rows.push({
      ...base(q),
      arm: "bm25",
      ranking: candidates.get(q.id)!.slice(0, 5),
      calls: 0,
      latency_ms: 0,
      input_tokens: 0,
      cost_usd: 0,
    });

async function rerank(
  arm: string,
  call: (s: unknown, qs: any) => Promise<Decision>,
  limit: number,
) {
  const out = await pool(
    queries,
    limit,
    async (q) => {
      const cands = candidates.get(q.id)!;
      if (!cands.length) return { ranking: [], d: null as Decision | null };
      const { state, questions } = rerankCall(db, config, q.query, cands);
      const d = await call(state, questions);
      const scored = cands.map((path, i) => ({ path, p: d.answers[`c${i + 1}`]?.p ?? -1, i }));
      scored.sort((a, b) => b.p - a.p || a.i - b.i);
      return { ranking: scored.slice(0, 5).map((s) => s.path), d };
    },
    arm,
  );
  out.forEach((o, i) =>
    rows.push({
      ...base(queries[i]!),
      arm,
      ranking: o.ranking,
      calls: o.d ? 1 : 0,
      latency_ms: o.d?.latency_ms ?? 0,
      input_tokens: o.d?.input_tokens ?? 0,
      cost_usd: o.d?.cost_usd ?? 0,
      ...(o.d?.error ? { error: o.d.error } : {}),
    }),
  );
}
if (arms.has("jev-rerank")) await rerank("jev-rerank", jev, 16);
if (arms.has("haiku-rerank"))
  await rerank("haiku-rerank", haiku, Number(process.env.HAIKU_CONCURRENCY ?? 12));

if (arms.has("jev-nav")) {
  const out = await pool(
    queries,
    16,
    async (q) => {
      let path = candidates.get(q.id)![0];
      const visited = new Set<string>();
      const trace: string[] = [];
      let calls = 0,
        latency = 0,
        tokens = 0,
        cost = 0,
        error: string | undefined;
      while (path && calls < PROTOCOL.max_hops) {
        visited.add(path);
        trace.push(path);
        const { state, questions, links } = hopCall(db, config, q.query, path, visited);
        if (!links.length) break;
        const d = await jev(state, questions);
        calls++;
        latency += d.latency_ms;
        tokens += d.input_tokens;
        cost += d.cost_usd;
        if (d.error) {
          error = d.error;
          break;
        }
        const choice = d.answers.next?.choice;
        if (!choice || choice === "here") break;
        path = links[Number(choice.slice(1)) - 1];
      }
      if (path && trace.at(-1) !== path) trace.push(path);
      return { ranking: path ? [path] : [], trace, calls, latency, tokens, cost, error };
    },
    "jev-nav",
  );
  out.forEach((o, i) =>
    rows.push({
      ...base(queries[i]!),
      arm: "jev-nav",
      ranking: o.ranking,
      trace: o.trace,
      calls: o.calls,
      latency_ms: o.latency,
      input_tokens: o.tokens,
      cost_usd: o.cost,
      ...(o.error ? { error: o.error } : {}),
    }),
  );
}

mkdirSync(RESULTS, { recursive: true });
const name = [...arms].sort().join("+");
writeFileSync(
  join(RESULTS, `r-t4-${name}.json`),
  JSON.stringify({ run_at: new Date().toISOString(), protocol: PROTOCOL, rows }) + "\n",
);
console.log(`${rows.length} rows, ${rows.filter((r: any) => r.error).length} errors`);
