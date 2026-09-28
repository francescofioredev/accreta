# T2: citation support

## 1. Question

Given a claim and the text it cites, can a decider tell whether the text supports the claim,
contradicts it, or says nothing about it, reliably enough to flag unsupported citations
automatically?

## 2. Hypothesis and falsification

`lint` checks that a cited file and line range exist. It never checks that the lines say what
the page claims (`packages/core/src/query/lint.ts`). A model can invent a line range, and the
page passes lint clean. A decider that reads the claim and the cited lines would make a
`citation-unsupported` finding possible. It would also make possible a guard on
`update_verified_revision` that refuses the cheap fix: bumping the revision without re-reading the source.

The dangerous error is a **false "supports"**, a citation accepted that does not back its claim.
A false "does not support" costs a human a second look.

**H1.** At a threshold fixed beforehand, the decider accepts at most 5% of non-supporting
citations as supporting, while still accepting at least 70% of the citations that do support.

- **Refuted** if the false-"supports" rate on the test split is 5% or higher, or if fewer than
  70% of supporting pairs are accepted.
- **Demonstrated** only if the upper bound of the 95% interval is also below 5%.

**H2 (descriptive).** Jev compared with Haiku on the same pairs.

## 3. Pre-registration

**Tier R, SciFact.**
- **Data.** Test: SciFact's dev split, all 340 claim–abstract pairs.
- **Calibration.** 300 pairs drawn from SciFact's *train* split (seed 20260930), so the dev split
  is scored exactly once.
- **Threshold rule.** A pair is accepted as supporting when P(supports) ≥ τ. τ is the smallest
  value on a 0.01 grid whose false-"supports" rate on calibration is at most 5%.
- **Committed before any model call:** the question and protocol (`bench/jev/tasks/t2-scifact.ts`).
  The commit is in the run log.
- **Context.** Claim, title and abstract: the state SciFact itself defines, one level only. The
  context ladder (cited lines, ±N lines, whole section) applies to the RFC set, where the
  surrounding text exists.


**Tier A, real citations** (added 2026-09-28, committed before any model sees these pairs):
- **The pairs.** The baseline ingest (tier A of T1) wrote 992 citations into RFC 9111 and 6455
  across three runs. From each run, 50 are sampled (seed 20261004): claims of 30–600 characters,
  cited ranges of at most 120 lines. Each is paired twice:
  - with the lines it cites. The label is unknown: whether an agent's citation supports its claim
    is what the check is for;
  - with a constructed negative: the same claim against the other section of the same RFC that
    shares the most vocabulary with it, so the negative is hard.
- **Levels:** C0 the cited lines; C1 the cited lines ±10; C2 the whole enclosing section.
  - C1 is declared primary, since it is what opening a citation shows.
  - τ is carried over from the SciFact calibration, because tier A has no calibration split.
- **References.**
  - Claude Opus 5.5 labels every pair at C1.
  - The maintainer audits 30 pairs blind, so the Opus labels can be trusted only as far as they
    agree with a person.

## 4. Setup

**The question.** Asked of Jev as a `choice`, and of Haiku as one probability per option:

> What does the cited text say about the claim?
>
> - *supports*: the cited text states or directly implies the claim
> - *contradicts*: the cited text states or directly implies that the claim is false
> - *says_nothing*: the cited text does not settle whether the claim is true

**The state.** `{ "claim": …, "cited_title": …, "cited_text": … }`.

**SciFact** ([Wadden et al., 2020](https://aclanthology.org/2020.emnlp-main.609/)). Claims
written by experts from biomedical papers, each paired with the abstracts it cites. Each pair
is labelled SUPPORT or CONTRADICT with rationale sentences, or is not-enough-info when the cited
abstract carries no evidence. The labels are the experts'. Licence CC BY-NC 2.0: fetched by
`bench/jev/fetch/scifact.ts`, never committed.

## 5. Dataset

| Split | supports | contradicts | says nothing |
| --- | --- | --- | --- |
| Calibration (SciFact train sample) | 124 | 62 | 114 |
| Test (SciFact dev) | 138 | 71 | 131 |

## 6. Metrics and why these

- **The gated error:** the false-"supports" rate at τ, and the share of supporting pairs still
  accepted at τ.
- **Accuracy and macro F1 over the three labels**, only so the figures can be compared with the
  SciFact literature's label-prediction setting.
- **The three-way confusion matrix.**
- **Latency p50/p95 and cost per 1,000.**

## 7. Results

### Tier R: SciFact

<!-- report:t2-scifact -->

SciFact dev, 340 claim–abstract pairs (138 supports, 71 contradicts, 131 says nothing). τ fixed on 300 pairs from SciFact train.

| Arm | Accuracy | Macro F1 | False “supports”, argmax | τ | False “supports” at τ | Supports accepted at τ | Latency p50 / p95 | Cost per 1,000 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| jev | 0.862 | 0.860 | 8.4% (17/202; 95% CI 5.0%–13.1%) | 0.73 | 6.9% (14/202; 95% CI 3.8%–11.4%) | 83.3% (115/138; 95% CI 76.0%–89.1%) | 312 / 453 ms | $0.033 |

Confusion, test (rows are the gold label, columns the prediction):

| Arm | Gold | supports | contradicts | says_nothing |
| --- | --- | --- | --- | --- |
| jev | supports | 120 | 7 | 11 |
| jev | contradicts | 4 | 65 | 2 |
| jev | says_nothing | 13 | 10 | 108 |

<!-- /report:t2-scifact -->

### Tier A: citations an ingest agent wrote

<!-- report:t2-atlas -->
<!-- /report:t2-atlas -->

## 8. What this does and does not show

_To be completed with the results._

## 9. Reproduce

```bash
bun bench/jev/fetch/scifact.ts
wrangler dev --config bench/jev/proxy/wrangler.jsonc --port 8799
bun bench/jev/tasks/run-t2-scifact.ts
bun bench/jev/report.ts
```

## 10. Run log

| Date | Commit | What | Outcome |
| --- | --- | --- | --- |
| 2026-09-28 | `95c6c86` | SciFact question and protocol committed | — |
| 2026-09-28 | — | Jev on SciFact | Complete. 18 calls failed with the transient Cloudflare `2018` error and succeeded on rerun |
| 2026-09-28 | _pre-registration_ | Tier A pairs, levels and references committed | — |
