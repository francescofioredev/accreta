# A decision model in accreta: Jev, September 2026

These are findings, not decisions. A decision is an ADR.

## The question

How much better would accreta be if the judgments it leaves to the agent were taken by a typed
decision model? Those judgments are: is this claim still true, do these lines support it, is this
section worth reading, which page answers this query.

The model is [Jev](what-jev-is.md). It reads a state and returns calibrated probabilities over
options you define, at about a third of a second and a few cents per thousand decisions. It
writes no text.

## The answer

<!-- report:headline -->

| Question | Measure | Deterministic / baseline | Jev | Claude Haiku 4.5 |
| --- | --- | --- | --- | --- |
| Drift, RFC errata: did the correction change the meaning? | AUROC vs IETF label | 0.57 | 0.74 | 0.67 |
|  | AUROC vs frontier annotator | 0.57 | 0.93 | 0.83 |
|  | the annotator agrees with the IETF label | 72% |  |  |
| Drift, claims over errata: is the claim still true? | AUROC vs IETF label (test split) | — | 0.53 | 0.51 |
|  | AUROC vs frontier annotator | — | 0.95 | 0.90 |
| Drift, claims over code (got v13 → v14.4) | citations left after hunk ∩ range (free) | 114 of 683 (17%) |  |  |
|  | AUROC on those, vs frontier annotator (test split) | — | 0.98 | 0.94 |
| Citation support, SciFact (expert labels) | accuracy, three labels | — | 86.2% | 85.9% |
| Retrieval, paraphrase queries (9,842 pages) | recall@1: BM25, then BM25 top 20 reranked in one call | 70% | 86% | 90% |
| Retrieval, supersession queries (9,842 pages) | recall@1: BM25, then BM25 top 20 reranked in one call | 23% | 65% | 66% |
|  | recall@1: BM25, then following typed links from its top hit | 23% | 57% | — |
| Latency per decision, p50 (errata, all 1,000) |  | — | 341 ms | 13790 ms (through the CLI) |

<!-- /report:headline -->

Each row links to a card in [`experiments/`](experiments/). Every figure there is regenerated from
`bench/jev/results/` by `bun bench/jev/report.ts`.

**Ingest, the expensive phase: no.**
- The ingest agent cites almost every section of an RFC, and code that holds 79% of a codebase's
  characters, so there is little to skip.
- Reading the source is a minority of what ingest costs. Most of the bill is the agent writing
  pages and re-reading its own context turn after turn.
- Jev ranks code for triage worse than the length of each declaration does. At the recall a knowledge
  base needs, it would save on the order of 1% of an ingest. That figure is REASONED from the cost
  breakdown in the card, not measured end to end.
- Card: [T1](experiments/t1-ingest-triage.md).

**Retrieval: yes, on top of the index, not instead of it.**
- Reranking the top 20 BM25 hits in one call closes most of the gap where lexical search fails:
  paraphrased questions, and questions whose answer is the page that replaced the one named.
- Following typed links from BM25's top hit closes much of the same gap.
- Navigating with no index at all cannot reach the 60% of pages with no links, and the index is
  nearly free: a 9,842-page rebuild takes about five seconds.
- Card: [T4](experiments/t4-wiki-navigation.md).

**Drift: the largest gain needs no model.**
- Today a source change stales every page that cites it. Intersecting each citation's line range
  with the diff's hunks leaves 17% of code citations to re-check, and in a 60-item sample it
  wrongly cleared none.
- On the rest, Jev's ranking of broken against intact claims agrees closely with a frontier
  annotator, Claude Opus 5.5 used as a second labeller (AUROC 0.93–0.98). Haiku's AUROC is lower on
  every set; no interval was computed for the difference.
- Against the IETF's own labels on errata it looks far weaker (0.53–0.74). Which reference is right
  is what the pending audit decides.
- Card: [T3](experiments/t3-drift-triage.md).

**Citation support: feasible, and cheap.**
- On SciFact's expert labels Jev matches Haiku at a small fraction of the cost.
- On code it accepts under 5% of mismatched citations when shown only the cited lines.
- On RFCs and on code, showing it more than the cited lines makes it worse.
- Card: [T2](experiments/t2-citation-support.md).

## What would follow, if these hold

The first change needs no model at all. Drift at line-range granularity, intersecting
`canonical_source` and footnote locators with the diff, belongs in `packages/core` whatever
happens with decision models.

Beyond that, any use of a model reverses a standing decision: accreta has never called one
([F-ME-05](../2026-08-review/06-model-economist.md)). The shape that fits the evidence is an
optional judge port, sketched in [ADR-0014](../../adr/0014-an-optional-judge-port.md) and still
proposed:
- provider-neutral, like `SourceAdapter`, so Jev is one implementation and any structured-output
  model another;
- off by default;
- advisory only: it ranks and flags, and never edits a page or bumps a revision.

## What this does not show

- **The labels.** The drift and citation-support figures against a frontier annotator are that
  annotator's judgement. The IETF's classification disagrees with it on 28% of errata.
  A blind human audit of fixed samples (`bench/jev/audit.ts`) decides which to trust, and it has
  not been run yet.
- **One codebase, one kind of prose.** One TypeScript library at one pair of tags, and IETF RFCs,
  which are written to be cited. Messier sources are likely to score lower (REASONED).
- **A young vendor through a reseller.** Twelve to thirteen days after launch, through Cloudflare's
  binding, with 1–3% of calls failing transiently and succeeding on retry. Direct sign-ups are
  closed. Results are dated to this week.
- **Haiku's cost and latency are upper bounds.** Haiku ran through the `claude` CLI, which adds a
  fixed prompt and its own reasoning. The direct API would cost less than the figures shown
  (REASONED from the CLI's fixed prompt of about 1,300 tokens per call), and still well above Jev.

## How to read the rest

| File | What it is |
| --- | --- |
| [`what-jev-is.md`](what-jev-is.md) | The model from its documentation, vendor claims against independent ones, and what it may and must not decide here |
| [`decision-points.md`](decision-points.md) | Every judgment accreta leaves to the agent, and the verdict on each |
| [`experiments/`](experiments/README.md) | The shared method, and one card per question: pre-registration, setup, results, threats, reproduction, run log |
| [`bench/jev/`](../../../bench/jev/README.md) | The harness, the datasets and every result row |
