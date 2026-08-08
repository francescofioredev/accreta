#!/usr/bin/env bun
/**
 * Measure retrieval quality over the evaluation corpus.
 *
 * The question ADR-0001 has to settle: does semantic search measurably help on a
 * curated, cross-referenced corpus, or is lexical search over that corpus already
 * sufficient? A negative result is a result — an unmeasured feature is not.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildIndex, openIndex, parseConfig, searchPages, type Database } from "@accreta/core";

const BENCH_DIR = dirname(fileURLToPath(import.meta.url));
const CORPUS = join(BENCH_DIR, "corpus");

interface Query {
  id: string;
  class: string;
  query: string;
  relevant: string;
}

const STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "of",
  "to",
  "in",
  "on",
  "at",
  "by",
  "for",
  "with",
  "and",
  "or",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "does",
  "do",
  "did",
  "how",
  "why",
  "what",
  "where",
  "when",
  "which",
  "that",
  "this",
  "it",
  "its",
  "if",
  "than",
  "then",
  "there",
  "here",
  "much",
  "more",
  "can",
  "we",
  "us",
  "you",
  "several",
  "instead",
  "one",
  "actually",
  "versus",
  "makes",
  "make",
]);

/**
 * Prepare a natural-language query for FTS5.
 *
 * FTS5's query language treats punctuation and some bare words as syntax, so a
 * question typed by a human is not a valid query string. Each surviving term is
 * quoted and joined with OR, which is the most permissive reading — deliberately
 * generous to the lexical side, because the question is whether lexical search is
 * good enough, not whether it can be handicapped into losing.
 */
function toFtsQuery(natural: string): string {
  const terms = natural
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
  if (terms.length === 0) return `"${natural.replace(/"/g, "")}"`;
  return terms.map((t) => `"${t}"`).join(" OR ");
}

interface Result {
  id: string;
  class: string;
  query: string;
  relevant: string;
  rank: number | null;
}

function evaluate(db: Database, queries: Query[]): Result[] {
  return queries.map((q) => {
    const hits = searchPages(db, { query: toFtsQuery(q.query), limit: 10 });
    const index = hits.findIndex((h) => h.path === q.relevant);
    return { ...q, rank: index === -1 ? null : index + 1 };
  });
}

function metrics(results: Result[]) {
  const n = results.length;
  const recallAt = (k: number) => results.filter((r) => r.rank !== null && r.rank <= k).length / n;
  const mrr = results.reduce((sum, r) => sum + (r.rank ? 1 / r.rank : 0), 0) / n;
  return { n, recall1: recallAt(1), recall5: recallAt(5), mrr };
}

const pct = (x: number) => `${(x * 100).toFixed(0)}%`;

const config = parseConfig(readFileSync(join(CORPUS, "accreta.config.yaml"), "utf-8"));
const indexPath = join(CORPUS, ".accreta", "index.sqlite");
const build = buildIndex({ root: CORPUS, config, indexPath });

const { queries } = JSON.parse(readFileSync(join(BENCH_DIR, "queries.json"), "utf-8")) as {
  queries: Query[];
};

const db = openIndex(indexPath, { readonly: true });
const results = evaluate(db, queries);

console.log(
  `corpus: ${build.pages} pages, ${build.links} links, indexed in ${build.ms.toFixed(0)}ms`,
);
console.log(`queries: ${queries.length}\n`);

const overall = metrics(results);
console.log("LEXICAL (FTS5, porter unicode61)");
console.log(
  `  recall@1 ${pct(overall.recall1)}   recall@5 ${pct(overall.recall5)}   MRR ${overall.mrr.toFixed(3)}\n`,
);

console.log("by query class");
for (const cls of [...new Set(queries.map((q) => q.class))]) {
  const m = metrics(results.filter((r) => r.class === cls));
  console.log(
    `  ${cls.padEnd(11)} n=${String(m.n).padEnd(3)} recall@1 ${pct(m.recall1).padStart(4)}   recall@5 ${pct(m.recall5).padStart(4)}   MRR ${m.mrr.toFixed(3)}`,
  );
}

const missed = results.filter((r) => r.rank === null || r.rank > 1);
if (missed.length > 0) {
  console.log(`\nnot returned first (${missed.length}/${results.length})`);
  for (const r of missed) {
    console.log(`  [${r.class}] "${r.query}"`);
    console.log(`      want ${r.relevant}`);
    console.log(`      rank ${r.rank ?? "not in top 10"}`);
  }
}

db.close();
