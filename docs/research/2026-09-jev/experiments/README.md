# Experiments: shared method

Each card in this directory measures one decision accreta currently leaves to the agent, and
asks whether a typed decision model can take it over. The cards share the method below, so it
is stated once.

## Arms

Every task compares the same kinds of decider:

- **The deterministic step alone**, wherever one exists. If a regex or a line-range check already
  gets most of the way, a model has to beat that, not a straw man.
- **Jev** (`typesafe/jev` through the Cloudflare Workers AI binding). The served version is recorded
  on every row.
- **Claude Haiku 4.5**, asked the same questions through structured output. This is the fair
  comparison: the cheapest general-purpose model that is plausibly good enough to make the same decision.
  It runs through the `claude` CLI in `--safe-mode` from a directory outside the repository. Its latency
  is the API time the CLI reports; the CLI's own start-up is excluded.

## Tiers

| Tier | Corpus | What it is for |
| --- | --- | --- |
| **A: atlas** | RFC 9111 and RFC 6455, two of the eight RFCs vendored in [accreta-atlas](https://github.com/francescofioredev/accreta-atlas) | In-domain and small: pages written the way accreta's constitution asks. Directional only. |
| **R: RFC scale** | The RFC series, errata feed and index from the RFC Editor | Enough items per class to decide a gate, with labels made by people outside this project. |
| **C: codebase** | One TypeScript repository pinned at two tags | The launch target: code, not prose. |

## Where labels come from

In order of preference:

1. **Labels made by someone else, before this study.** The IETF's classification of an erratum as
   Technical or Editorial, citations between RFCs, and the SciFact benchmark's annotations. Nobody
   involved in this study chose them.
2. **Labels by construction.** For example, pairing a claim with lines from a different section to
   make a negative. The builder decides the label, so its noise is measured on an audit sample.
3. **The maintainer's hand labels**, only for audit samples. Where two raters label the same items,
   Cohen's kappa is reported. Below 0.6 the rubric is treated as broken.

## Pre-registration

Each card's question, hypothesis, falsification rule, operating point and sample sizes are
committed together with the datasets and question schemas **before any model sees the items**.
The card cites that commit. A threshold is never tuned on the split it is reported on: where a
threshold is needed, it is fixed on a calibration split and the result is reported on a held-out
test split.

## Intervals and metrics

- Every rate carries an exact (Clopper–Pearson) 95% interval.
- Where one kind of error is worse than the other, as a false "still valid" is worse than a false
  "changed", the card reports the full confusion matrix and the dangerous error separately. It
  never reports F1, which averages away exactly that asymmetry.
- Rankings add AUROC; probabilities add Brier score and expected calibration error (10 bins).
- Latency is p50 and p95. Cost is dollars per 1,000 decisions, at list prices checked on the
  run date and recorded in the card.

## Data and licences

Third-party data is fetched by script into `bench/jev/.external/`, which is not committed.
[`bench/jev/data/snapshots.json`](../../../../bench/jev/data/snapshots.json) records each
file's URL, fetch date and sha256, and the fetch scripts refuse a file whose hash has moved.
The datasets in `bench/jev/data/` hold item ids, splits, labels and text hashes, not the
third-party text itself.

- **RFCs and the errata feed:** published by the RFC Editor under the IETF Trust's legal
  provisions.
- **SciFact:** CC BY-NC 2.0, which is why it is fetched rather than vendored.
- **The tier C repository:** [got](https://github.com/sindresorhus/got), an HTTP client for
  Node.js, MIT licence. It is cloned at its tags by the harness, never vendored.

## Results

`bench/jev/results/` holds one row per item per arm, committed, so every figure in these cards
can be recomputed. The call cache (`bench/jev/.cache/`) is local: a rerun of a completed task makes
no calls.

## Terms used in the cards

| Term | Meaning |
| --- | --- |
| AUROC | The probability that a decider scores a random positive above a random negative. 0.5 is chance and 1.0 is a perfect ranking. It does not depend on any threshold |
| τ (tau) | The threshold on a decider's probability that turns it into an action (clear, keep, accept). Fixed on a calibration split, or carried over from another task where a card says so; never tuned on the split it is reported on. The one post-hoc threshold (tier C drift) is labelled as such |
| Recall@k | The share of queries whose relevant page is among the top k results |
| BM25 | The lexical ranking SQLite FTS5 uses, and so the one accreta's `search_pages` uses |
| Hunk | One contiguous changed region in a diff |
| `noul`, `choice`, `score` | Jev's question types: a probability of yes; a distribution over described options; a level on a rubric |
| Frontier annotator | Claude Opus 5.5, used as a second labeller where no human label exists. Its labels count only as far as the blind audit confirms them |
| Levels | The state a decider sees, from least to most. T1: S0–S2 and P (RFC sections), U0–U1 and P (code units); P packs a whole document into one call. T2: C0–C2 (cited lines, ±10 lines, enclosing section). T3: L0–L3 (texts, diff, surrounding section, claim) |
| Tiers | A (accreta-atlas, small), R (the RFC series, at scale), C (the got codebase) |
| Transient `2018` error | A Cloudflare AI Gateway error ("Invalid User Credentials") returned intermittently on calls that succeed when retried with the same credentials |
