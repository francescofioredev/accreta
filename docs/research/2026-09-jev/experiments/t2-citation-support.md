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
<!-- /report:t2-scifact -->

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
| 2026-09-28 | _pre-registration_ | SciFact question and protocol committed | — |
