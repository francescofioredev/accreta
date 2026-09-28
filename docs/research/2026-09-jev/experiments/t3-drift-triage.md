# T3: drift triage

## 1. Question

When a source changes under a cited claim, can a decider tell a change of meaning from a
cosmetic one reliably enough to clear drift without an agent re-reading the source?

## 2. Hypothesis and falsification

Today drift is file-level. Any change to a cited file marks every page that cites it as stale
(`packages/core/src/source/drift.ts`), and the agent then re-reads the source to decide whether the
claims still hold. The [constitution](../../../../templates/constitution/base.md) calls a false
"still valid" the most damaging outcome, because nothing ever flags it again.

**H1.** The decider shows a change of meaning with a false "still valid" rate below 5%, at a
threshold fixed beforehand, while clearing at least 30% of cosmetic changes. If it clears
fewer, it saves too little re-reading to be worth a model call.

- **Refuted** if the false "still valid" rate on the test split is 5% or higher, or if it clears
  fewer than 30% of editorial items at the threshold.
- **Demonstrated** only if the upper bound of the 95% interval is also below 5%.
- **Consistent with** if the point estimate is below 5% but the upper bound is not.

**H2 (descriptive).** Jev is compared with Haiku and with the deterministic arms on the same items,
at the same kind of threshold. No winner is declared on a difference inside overlapping intervals.

## 3. Pre-registration

- **Committed before any model call on these items:** the dataset (`bench/jev/data/t3-errata.json`),
  the question and the protocol (`bench/jev/tasks/t3-errata.ts`). The commit is in the run log below.
- **Threshold rule.** An item is cleared as "still valid" when P(meaning changed) < τ.
  τ is the largest value on a 0.01 grid whose false "still valid" rate on the
  **calibration** split is at most 2%, a margin under the 5% gate. The gate is judged on the
  **test** split only.
- **Sample sizes (tier R).**
  - Calibration: 100 technical, 100 editorial.
  - Test: 400 technical, 400 editorial.
  
  At 400, a 5% error rate carries an interval of about ±2 points.
- **Repeatability.** Jev is asked twice on 50 test items per class, to see whether its answer
  varies. Haiku gets one sample per item.

### Amendment 1: context and question form as factors (committed before any call they make)

The first run gave Jev one level of context: the RFC title and section, plus the two texts. Three
things suggest that level, not the model, may be what limits the result:

- **Small changes are hard for it.** Jev's AUROC falls to 0.66 when fewer than 5% of the words
  change, against 0.74–0.78 otherwise.
- **Its probabilities are poorly calibrated** (ECE 0.147).
- **Jev's own documentation says so.** It advises filtering in code and sending only what the
  question needs.

The first run is kept as it stands, as **L0, minimal context**. It is not "Jev's result".

**Levels** (`bench/jev/tasks/t3-ladder.ts`):

| Level | State |
| --- | --- |
| L0 | RFC, section, original text, corrected text |
| L1 | L0 plus a word-level diff computed in code: each changed span with six words either side |
| L1b | the diff alone, without the full texts |
| L2 | L1 plus the RFC section around the erratum, up to 4,000 characters, from the mirrored RFC text. It is located in 943 of 1,000 items |

**Forms.** The same question is asked as a `noul`, or as a `choice` between *technical* and
*editorial* with the IETF's definitions as the options.

**Selection without forking paths.**
- The configuration (level × form) is chosen by **AUROC on the calibration split only**. Ties go
  to the smaller state.
- τ for that configuration is then fixed on calibration by the original rule, and the test split
  is scored once.
- Every other configuration is also reported on test, labelled exploratory.
- Haiku is run at the selected configuration as well as at L0, so it is compared at the same context.

**L3, the production shape.** accreta's real question is not "did the meaning change?" but
"is *this claim* still true?".
- **Claims.** `bench/jev/builders/claims-t3.ts` has Claude Sonnet 5 write one claim per erratum
  from the original text. The writer sees the changed passage marked, but never the corrected
  text or the label.
- **Sample.** 25 calibration and 100 test items per class. The claims are committed before
  any judge sees them.
- **Question.** "Given the corrected text, is the claim now wrong or no longer supported?"
- **Where it is reported.** Separately from the ladder, since it answers a different question.

**Batching (exploratory, not pre-registered).**
- Jev takes many questions over one state in a single call.
- At the selected level, K = 1, 5, 10 and 25 test items are packed into one state: a shared
  rubric, and one short question per item.
- Measured: the loss in AUROC and in the gated error, tokens per decision, and latency per call
  and per decision.
- Packing unrelated items into one state is what Jev's documentation warns degrades accuracy,
  so this measures the cost of that saving rather than assuming it.


### Tier C: code (committed before any model sees these items)

**Setup.** The tier C ingest wrote pages over got's `source/` at v13.0.0: three runs, 683 distinct
citations with their claims. The source then moves to v14.4.0, which touches 13 files
(+214/−155). `bench/jev/builders/tier-c-drift.ts` records deterministic facts per citation:
- whether any `git diff -U0` hunk touches the cited range;
- where the range lands in v14.4.0;
- whether the innermost TypeScript declaration that encloses it is unchanged, changed or removed.
  The text is compared with whitespace and comments stripped.

**What accreta does today.** Every one of the 683 citations goes stale, because all of them cite
the same revision of the source. A per-file check would flag 658 of them (96%). Only 114 (17%) sit
under a hunk.

**Two questions.**
1. **Is the free step safe?** Clearing every untouched citation without a model is deterministic
   and costs nothing. It is wrong when a claim depends on code changed outside the cited lines.
   A seeded sample of 60 untouched citations is labelled to count those false clears.
2. **On the 114 touched citations, can a decider tell a claim that still holds from one that broke?**
   - The state is the claim, the cited lines before and after (±3 lines), and the word diff.
   - The question is L3's.
   - τ is fixed by the original rule on a seeded third of the touched items; the other two thirds are scored.

**Labels.**
- Claude Opus 5.5 labels every touched item and the untouched sample: invalidated, valid or unsure.
- The maintainer audits 30 of them blind.
- The Opus labels stand only as far as they agree with the audit.

## 4. Setup

**Tier R.** Verified errata from the RFC Editor's errata feed, snapshot of 2026-09-27
(sha256 in `bench/jev/data/snapshots.json`). The IETF classifies each erratum:

- **Technical:** an error in the technical content;
- **Editorial:** a spelling, grammar, punctuation or syntax error that does not affect the
  technical meaning.

That classification is the ground truth. It is also exactly the distinction drift has to make.

An erratum becomes a drift item as follows:

- the erratum's *original text* is the text a page's claim was written from;
- its *corrected text* is what the source now says;
- a Technical erratum is a change that can invalidate a claim;
- an Editorial erratum is one that cannot.

The state given to each decider:

```json
{ "rfc": "RFC9110: HTTP Semantics", "section": "8.8.3", "original": "…", "corrected": "…" }
```

The erratum's notes are withheld: they often say "typo" or explain the error, which would hand
over the label.

The question, asked of Jev as a `noul` and of Haiku as a probability:

> Does the corrected text change the technical meaning of the original text: what an
> implementation must, should or may do, a value, a format or grammar rule, or a described
> behaviour, so that a statement someone wrote from the original text could now be wrong? A
> fix to spelling, grammar, punctuation or layout that leaves the technical meaning unchanged is
> not a change of meaning.

The wording mirrors the IETF's own definition of an editorial erratum, so the decider is asked
what the label means rather than a paraphrase of it.

**Deterministic arms.**

- `whitespace-only`: a change counts if anything other than whitespace differs.
- `normative-regex`: a change counts if the RFC 2119 keywords or the numbers differ. This is
  what a careful rule-writer would try first.

## 5. Dataset

`bench/jev/builders/errata.ts` builds the dataset (seed 20260927).

**Eligible errata.** Verified, Technical or Editorial, both texts present and different, and
together under 8,000 characters. That leaves 1,885 technical and 1,698 editorial.

**Sampling.**
- Per class: shuffled, deduplicated, and capped at two errata per RFC, so that no single document
  dominates.
- The result is 1,000 items across 765 RFCs. The first 100 per class form the calibration split.

**Label noise.** Not every IETF classification is one this study would make. Some Editorial
errata fix a grammar rule's syntax, and five Technical errata differ only in whitespace.
The label noise is measured on an audit sample of 60 items (30 per class) that the maintainer labels blind (see
§7).

## 6. Metrics and why these

- **At τ, for each arm:**
  - the false "still valid" rate, i.e. technical items cleared (the gated error);
  - the clearing rate on editorial items, i.e. how much re-reading is saved.
- The full confusion matrix; never F1.
- AUROC, to see whether the decider ranks at all, independent of τ.
- Brier score and expected calibration error, to see whether its probabilities can be read as
  probabilities.
- Latency p50/p95 and cost per 1,000 decisions.

## 7. Results

### Tier R

<!-- report:t3-r -->

Test split: 400 technical and 400 editorial errata. τ was fixed on the calibration split by the pre-registered rule.

| Arm | τ | False “still valid” (technical cleared) | Editorial cleared (re-reading saved) | AUROC | Brier | ECE | Latency p50 / p95 | Cost per 1,000 | Errors |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| whitespace-only | 0.99 | 1.0% (4/400; 95% CI 0.3%–2.5%) | 1.0% (4/400; 95% CI 0.3%–2.5%) | 0.500 | — | — | — | $0 | 0 |
| normative-regex | 0.00 | 0.0% (0/400; 95% CI 0.0%–0.9%) | 0.0% (0/400; 95% CI 0.0%–0.9%) | 0.566 | — | — | — | $0 | 0 |
| haiku | 0.00 | 0.0% (0/400; 95% CI 0.0%–0.9%) | 0.0% (0/400; 95% CI 0.0%–0.9%) | 0.669 | 0.331 | 0.331 | 13790 / 32393 ms | $7.435 | 0 |
| jev | 0.04 | 1.0% (4/400; 95% CI 0.3%–2.5%) | 10.3% (41/400; 95% CI 7.5%–13.6%) | 0.740 | 0.231 | 0.147 | 341 / 477 ms | $0.023 | 0 |

Confusion matrix at τ, test split:

| Arm | Technical → flagged | Technical → cleared ✗ | Editorial → flagged | Editorial → cleared |
| --- | --- | --- | --- | --- |
| whitespace-only | 396 | 4 | 396 | 4 |
| normative-regex | 400 | 0 | 400 | 0 |
| haiku | 400 | 0 | 400 | 0 |
| jev | 396 | 4 | 359 | 41 |

Repeatability: Jev asked twice on 100 test items. Median |Δp| 0.010, max 0.100; the decision at τ flipped on 2 of 100.

![Trade-off between the gated error and the re-reading saved, test split](t3-tradeoff.svg)

<!-- /report:t3-r -->

### Tier R, amendment 1: context ladder

<!-- report:t3-ladder -->

Selected on calibration AUROC: **L0-noul**. Test figures for every other configuration are exploratory.

| Arm and configuration | AUROC, calibration | AUROC, test | τ | False “still valid”, test | Editorial cleared, test | ECE, test | Input tokens | Cost per 1,000 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| jev L0-noul **(selected)** | 0.747 | 0.740 | 0.04 | 1.0% (4/400; 95% CI 0.3%–2.5%) | 10.3% (41/400; 95% CI 7.5%–13.6%) | 0.147 | 559 | $0.023 |
| jev L0-choice | 0.739 | 0.756 | 0.00 | 0.0% (0/400; 95% CI 0.0%–0.9%) | 0.0% (0/400; 95% CI 0.0%–0.9%) | 0.249 | 574 | $0.024 |
| jev L1-noul | 0.738 | 0.748 | 0.04 | 0.8% (3/400; 95% CI 0.2%–2.2%) | 9.3% (37/400; 95% CI 6.6%–12.5%) | 0.149 | 629 | $0.026 |
| jev L1-choice | 0.737 | 0.759 | 0.00 | 0.0% (0/400; 95% CI 0.0%–0.9%) | 0.0% (0/400; 95% CI 0.0%–0.9%) | 0.251 | 644 | $0.027 |
| jev L1b-noul | 0.666 | 0.725 | 0.05 | 0.3% (1/400; 95% CI 0.0%–1.4%) | 3.3% (13/400; 95% CI 1.7%–5.5%) | 0.079 | 448 | $0.019 |
| jev L1b-choice | 0.685 | 0.727 | 0.03 | 0.3% (1/400; 95% CI 0.0%–1.4%) | 7.2% (29/400; 95% CI 4.9%–10.2%) | 0.229 | 463 | $0.019 |
| jev L2-noul | 0.736 | 0.748 | 0.04 | 1.0% (4/400; 95% CI 0.3%–2.5%) | 10.5% (42/400; 95% CI 7.7%–13.9%) | 0.151 | 1249 | $0.052 |
| jev L2-choice | 0.745 | 0.768 | 0.00 | 0.0% (0/400; 95% CI 0.0%–0.9%) | 0.0% (0/400; 95% CI 0.0%–0.9%) | 0.228 | 1264 | $0.053 |
| haiku L0-noul | 0.672 | 0.669 | 0.00 | 0.0% (0/400; 95% CI 0.0%–0.9%) | 0.0% (0/400; 95% CI 0.0%–0.9%) | 0.331 | 1764 | $7.435 |

<!-- /report:t3-ladder -->

### Tier R, amendment 1: L3, claim-conditioned

<!-- report:t3-l3 -->

Claim-conditioned question. There are 25 calibration items per class, so τ rests on a small set: at 2% of 25, no technical item may be cleared.

| Arm | τ | AUROC, test | False “still valid”, test | Editorial cleared, test | ECE | Input tokens |
| --- | --- | --- | --- | --- | --- | --- |
| jev | 0.16 | 0.526 | 13.1% (13/99; 95% CI 7.2%–21.4%) | 27.0% (27/100; 95% CI 18.6%–36.8%) | 0.365 | 652 |
| haiku | 0.00 | 0.512 | 0.0% (0/99; 95% CI 0.0%–3.7%) | 0.0% (0/100; 95% CI 0.0%–3.6%) | 0.483 | 1852 |

<!-- /report:t3-l3 -->

### Tier R, amendment 1: batching (exploratory)

<!-- report:t3-batch -->

Level L0, packed: one shared rubric, one `noul` per item. τ = 0.04, from the selected unpacked configuration's calibration split. Test split only, 800 items per K.

| K per call | AUROC | False “still valid” | Editorial cleared | Input tokens per decision | Cost per 1,000 | Latency per call p50 / p95 | Latency per decision p50 | Missing answers |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 0.694 | 0.3% (1/400; 95% CI 0.0%–1.4%) | 6.5% (26/400; 95% CI 4.3%–9.4%) | 606 | $0.0255 | 417 / 602 ms | 417 ms | 0 |
| 5 | 0.712 | 0.5% (2/400; 95% CI 0.1%–1.8%) | 3.5% (14/400; 95% CI 1.9%–5.8%) | 329 | $0.0138 | 405 / 588 ms | 81 ms | 0 |
| 10 | 0.720 | 0.5% (2/400; 95% CI 0.1%–1.8%) | 3.3% (13/400; 95% CI 1.7%–5.5%) | 294 | $0.0123 | 406 / 539 ms | 41 ms | 0 |
| 25 | 0.731 | 0.0% (0/400; 95% CI 0.0%–0.9%) | 1.3% (5/400; 95% CI 0.4%–2.9%) | 274 | $0.0115 | 363 / 536 ms | 15 ms | 0 |

<!-- /report:t3-batch -->

### Tier C: code

<!-- report:t3-got -->

Labels are Claude Opus 5.5's, pending the maintainer's blind audit. They are to be read as the annotator's judgement, not as ground truth.

| Step | Citations still to re-verify | Share of 683 |
| --- | --- | --- |
| accreta today: every page citing the revision | 683 | 100% |
| per-file check: citations into a changed file | 658 | 96.3% |
| cited range intersected with diff hunks | 114 | 16.7% |
| of those, invalidated according to the annotator | 8 | 1.2% |

**The free step.** In a seeded sample of untouched citations the annotator found 0.0% (0/60; 95% CI 0.0%–6.0%) invalidated: the ones hunk intersection would have cleared wrongly.

**The decider on touched citations.** 8 of 113 labelled touched citations are invalidated, all of them in the test split. The calibration split holds none, so the pre-registered τ rule has nothing to calibrate on and degenerates to clearing nothing. The columns below are therefore **post hoc**: the lowest probability any invalidated claim received, and the share of valid claims below it, which is what a threshold at that point would clear.

| Arm | Labelled items | AUROC vs annotator, all touched | AUROC, pre-registered test split | Lowest p on an invalidated claim | Valid claims below it (cleared) | Latency p50 | Cost per 1,000 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| jev | 113 | 0.985 | 0.977 (n=75) | 0.83 | 96.2% (101/105; 95% CI 90.5%–99.0%) | 322 ms | $0.048 |
| haiku | 113 | 0.952 | 0.940 (n=75) | 1.00 | 90.5% (95/105; 95% CI 83.2%–95.3%) | 11356 ms | $10.010 |

<!-- /report:t3-got -->

## 8. What this does and does not show

**Verdict on the pre-registered hypotheses.**
- **H1, tier R, against the IETF label: refuted.** At τ = 0.04 the false "still valid" rate is
  1.0% (upper bound 2.5%), well inside the gate. But only 10.3% of editorial errata are cleared,
  below the 30% floor. Amendment 1's context ladder selected the minimal level again, with the
  same outcome.
- **L3: refuted.** τ rests on 25 calibration items per class, and the false "still valid" rate on
  test is 13.1%.
- **Tier C: not decidable as registered.** No invalidated claim fell in the calibration split, so
  the τ rule degenerates. The post-hoc result is strongly positive, and rests on eight positives.
- **H2:** Jev's AUROC is above Haiku's on every set, against either reference.
- **All of the above use the IETF label or the annotator.** The audit decides which verdict
  applies to drift as accreta means it.

- **The IETF label is not the question drift asks.**
  - *Technical* means the original text was technically wrong. It does not mean that a claim
    written from it is now false.
  - The first run's ceiling (AUROC about 0.75 at every context level) and the frontier annotator's
    disagreement with the IETF on 28% of errata both point at the label, not only at the decider.
  - The blind audit (`bench/jev/audit.ts t3`, `l3`, `t3c`) decides which reference to trust.
  - Until it runs, figures against the annotator are the annotator's judgement.
- **Context does not rescue the errata result.**
  - Every level from the minimal state to the surrounding section scores about the same.
  - The word diff alone scores worse.
- **Code drift rests on eight invalidated claims.**
  - All eight fell in the test split, so the pre-registered τ rule had nothing to calibrate on.
  - The threshold that clears 96% of valid claims without missing one is post hoc, and eight
    positives cannot confirm it.
- **The free step's safety rests on 60 sampled citations.** Zero wrong clears bounds the rate
  below about 6%, not below 1%.
- **One codebase, one pair of tags.** got v13.0.0 → v14.4.0 is a real major release, but it is one.
- **Training data.** Errata and claims derived from public RFCs may have been seen by every model
  here; code from a popular library likely was.
- **Batching needs its own calibration.** Packing items into one call leaves the ranking intact,
  but moves the probabilities. A threshold fixed on unpacked calls clears less when applied to
  packed ones.

## 9. Reproduce

```bash
bun bench/jev/fetch/rfc.ts            # errata feed and index, hash-checked
bun bench/jev/builders/errata.ts      # rebuilds data/t3-errata.json exactly
wrangler dev --config bench/jev/proxy/wrangler.jsonc --port 8799   # holds the Cloudflare credentials
bun bench/jev/tasks/run-t3.ts                          # tier R, the original arms
bun bench/jev/tasks/run-t3-ladder.ts --stage=ladder    # amendment 1: levels and forms
bun bench/jev/tasks/run-t3-ladder.ts --stage=haiku
bun bench/jev/builders/claims-t3.ts                    # claims for L3 (Sonnet 5; cached)
bun bench/jev/tasks/run-t3-ladder.ts --stage=l3
bun bench/jev/tasks/run-t3-ladder.ts --stage=batch
bun bench/jev/tasks/annotate-t3.ts                     # post hoc: Opus 5.5 on the errata
bun bench/jev/tasks/annotate-l3.ts                     # post hoc: Opus 5.5 on the claims
bun bench/jev/tasks/ingest-got.ts                      # tier C baseline ingest (Claude Code)
bun bench/jev/builders/tier-c-drift.ts
bun bench/jev/tasks/run-t3-got.ts
bun bench/jev/audit.ts t3                              # the blind audit (also l3, t3c)
bun bench/jev/report.ts
```

## 10. Run log

| Date | Commit | What | Outcome |
| --- | --- | --- | --- |
| 2026-09-27 | `22b934c` | Dataset, question, protocol committed | — |
| 2026-09-27 | — | Jev (L0) and deterministic arms, all 1,000 items | Complete. 9 calls failed with a transient Cloudflare `2018` error and succeeded on rerun |
| 2026-09-27 | `971a0ee` | Blind audit sample drawn (30 per class) after the run showed label noise | — |
| 2026-09-27 | — | Haiku (L0) and the Opus 5.5 second annotator started | Paused by the maintainer at 416 and 84 of 1,000; resumed from the cache |
| 2026-09-28 | `4c0bba2` | Context ladder, question forms, L3 and batching committed before their calls | — |
| 2026-09-28 | — | Ladder (8 configurations), Haiku at the selected one, batching | Complete. 76 transient `2018` errors, all succeeded on rerun. Calibration selected L0-noul |
| 2026-09-28 | `5f47d4f` | 249 claims for L3 written by Sonnet 5 and committed before any judge (one of 250 failed to generate) | — |
| 2026-09-28 | — | L3, Jev and Haiku | AUROC near chance against the IETF label, which is not a claim-level label |
| 2026-09-28 | — | **Post hoc:** Opus 5.5 labels the 1,000 errata and the 249 claims | Added after the first run exposed label noise. It agrees with the IETF on 72% of errata |
| 2026-09-28 | `88ed878` | Tier C pre-registered: 683 citations, deterministic facts, samples | — |
| 2026-09-28 | — | Tier C, Jev, Haiku and the annotator | All eight invalidated claims fell in the test split; the τ rule degenerates and the threshold is reported post hoc |
| 2026-09-28 | `4629f72` | Blind audit samples for l3, t3c and t2a committed | Awaiting the maintainer |
