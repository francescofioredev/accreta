# T4: navigating the wiki without an index

## 1. Question

Can a decider find the page a query asks for by reading pages and choosing links, instead of, or
on top of, the compiled search index? And where lexical search fails, does that close the gap?

## 2. Hypothesis and falsification

The hypothesis comes from the maintainer. A model that chooses among options quickly and
cheaply might navigate a knowledge base the way a reader does, following links from page to
page, without needing compiled indexes. TypeSafe demonstrates Jev on wikiracing, which has exactly
that shape.

The case against is structural:
- **The index is nearly free.** The [scale measurement](#scale-what-the-index-costs) below puts a
  full rebuild of a 9,842-page knowledge base at about 5 seconds and a search at 14 ms.
- **Errors compound per hop.**
- **A page with no links cannot be reached at all.**

The case for is where lexical search is weak:
- paraphrased queries, where ADR-0001 found BM25 at 50% recall;
- questions whose answer sits one link away from the page the query names.

**H1 (complement, not replacement).** On the class where BM25 is weakest, the answer reachable
only through `superseded_by`, navigating from BM25's top hit raises recall@1 by at least 20
points over BM25 alone, without lowering it on the other classes by more than 5.

- **Refuted** if the gain on the supersession class is under 20 points, or if a class drops by more
  than 5 points.

**H2.** Reranking BM25's top 20 in one call (20 questions over one state) raises recall@1 on
paraphrase queries by at least 10 points.

**H3 (structural, not a model test).** Navigation with no index cannot reach pages without
links. The share of such pages bounds any index-free navigator from above.

## 3. Pre-registration

- **Committed before any model call on these queries:** the knowledge base builder
  (`bench/jev/builders/rfc-kb.ts`), the queries and their gold (`bench/jev/data/t4-queries.json`),
  and the arms and protocol (`bench/jev/tasks/t4-nav.ts`).
- **The BM25 arm was run before this commit.** It is deterministic and calls no model.
- **Queries**, 150 per class (seed 20261003):
  - **title:** the RFC's own title. A control: lexical search should find it.
  - **paraphrase:** a question written by Claude Sonnet 5 from the RFC's abstract, told to avoid
    the title, its acronyms and its distinctive terms. It does not always comply, so the lexical
    overlap is reported. Relevant: the RFC and the RFCs it obsoletes or is obsoleted by, which
    describe the same thing.
  - **supersession:** `What is the current specification that replaces "<title of an obsoleted
    RFC>"?`. Relevant: the end of the obsoleted-by chain, taken from the RFC index.
- **Arms:**
  - **BM25:** `searchPages`, the query's terms quoted and joined by OR.
  - **Jev rerank:** BM25's top 20 as one state, one `noul` per candidate, ranked by probability.
  - **Jev navigation:** start at BM25's top hit. At each hop, a `choice` between "this page" and
    each outgoing typed link, described by kind and target title. At most 4 hops, never revisiting
    a page.
  - **Haiku rerank:** the same state and questions as Jev rerank.
- **Metrics:** recall@1 and recall@5 per class. Navigation reports success@1, hops and latency.

## 4. Setup

**Knowledge base.** One page per RFC, 9,842 pages, built without any model from the RFC Editor's
index (snapshot hash in `bench/jev/data/snapshots.json`).
- **Page content:** title, status, date, keywords and abstract, with aliases "RFC N" and "RFCN".
- **Links:** obsoletes and obsoleted-by become `supersedes` and `superseded_by`; updates become
  `related`. 7,408 links.

### Scale: what the index costs

<!-- report:t4-scale -->

| Pages | Links | Full rebuild (3 runs) | Index size | Search | getPage | findRelated | lint | Machine |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 9842 | 7408 | 5038 ms, 5193 ms, 5167 ms | 28.1 MB | 14.1 ms | 2.5 ms | 18.7 ms | 205 ms | darwin arm64 |

5,908 of 9,842 pages (60.0%) have no supersession or update link in either direction. No index-free navigator can reach them from another page.

<!-- /report:t4-scale -->

## 5. Dataset

See §3. The query file records each query's gold paths.

## 6. Metrics and why these

- **Recall@1** is what an agent that reads only the top hit gets.
- **Recall@5** is what an agent willing to open five pages gets.
- For navigation, **hops and latency** are the cost of the answer. The per-hop accuracy implied
  by success@1 shows how fast errors compound.

## 7. Results

### Tier R

<!-- report:t4-r -->

150 queries per class over the 9,842-page knowledge base. Navigation's latency is the sum over its hops.

| Arm | Class | Recall@1 | Recall@5 | Model calls per query | Latency per query p50 / p95 | Cost per 1,000 queries | Errors |
| --- | --- | --- | --- | --- | --- | --- | --- |
| bm25 | title | 86.0% (129/150; 95% CI 79.4%–91.1%) | 98.0% (147/150; 95% CI 94.3%–99.6%) | 0 | — | $0 | 0 |
| bm25 | paraphrase | 70.0% (105/150; 95% CI 62.0%–77.2%) | 82.0% (123/150; 95% CI 74.9%–87.8%) | 0 | — | $0 | 0 |
| bm25 | supersession | 22.7% (34/150; 95% CI 16.2%–30.2%) | 63.3% (95/150; 95% CI 55.1%–71.0%) | 0 | — | $0 | 0 |
| jev-rerank | title | 94.7% (142/150; 95% CI 89.8%–97.7%) | 100.0% (150/150; 95% CI 97.6%–100.0%) | 1.00 | 335 / 491 ms | $0.157 | 0 |
| jev-rerank | paraphrase | 86.0% (129/150; 95% CI 79.4%–91.1%) | 95.3% (143/150; 95% CI 90.6%–98.1%) | 1.00 | 333 / 413 ms | $0.165 | 0 |
| jev-rerank | supersession | 64.7% (97/150; 95% CI 56.5%–72.3%) | 76.7% (115/150; 95% CI 69.1%–83.2%) | 1.00 | 335 / 448 ms | $0.151 | 0 |
| jev-nav | title | 86.7% (130/150; 95% CI 80.2%–91.7%) | — | 0.43 | 303 / 448 ms | $0.010 | 0 |
| jev-nav | paraphrase | 71.3% (107/150; 95% CI 63.4%–78.4%) | — | 0.43 | 325 / 766 ms | $0.011 | 0 |
| jev-nav | supersession | 57.3% (86/150; 95% CI 49.0%–65.4%) | — | 1.86 | 624 / 1418 ms | $0.044 | 0 |

<!-- /report:t4-r -->

## 8. What this does and does not show

_To be completed with the results._

## 9. Reproduce

```bash
bun bench/jev/fetch/rfc.ts
bun bench/jev/builders/rfc-kb.ts
bun bench/jev/tasks/scale-rfc-kb.ts      # builds the index, measures it
bun bench/jev/builders/t4-queries.ts     # paraphrases are cached; a fresh run regenerates them
wrangler dev --config bench/jev/proxy/wrangler.jsonc --port 8799
bun bench/jev/tasks/run-t4.ts
bun bench/jev/report.ts
```

## 10. Run log

| Date | Commit | What | Outcome |
| --- | --- | --- | --- |
| 2026-09-28 | — | Knowledge base built and indexed; BM25 arm run | Deterministic, no model |
| 2026-09-28 | _pre-registration_ | Queries, gold, arms and protocol committed | — |
