# ADR-0014: An optional judge port, advisory only

Status: accepted in part. The port, reranking and citation support are accepted; `stillHolds` is
proposed until the blind audit (#152)
Date: 2026-09-28; accepted in part 2026-09-29

## Context

accreta has never called a model, and the August review wrote down why: a `models:` block would
be advice the client can ignore, because the agent runs the loop, not accreta
([F-ME-05](../research/2026-08-review/06-model-economist.md)). Every judgment about meaning belongs
to the agent, and exists only as prose in the constitution.

The [decision-model study](../research/2026-09-jev/README.md) measured four of those judgments with
a typed decision model (Jev), against the deterministic step and Claude Haiku 4.5. The findings
split cleanly:

- **Retrieval.** Reranking the top BM25 hits closes most of the gap where lexical search fails:
  paraphrased questions, and answers one link away. Following typed links from the top hit
  closes part of it.
- **Citation support.** A cheap check that the cited lines back the claim is feasible, at a few
  cents per thousand citations. It is most reliable when it sees nothing but the cited lines.
- **Drift.** Most of the gain comes from a deterministic change: intersecting citations with the
  diff's hunks. A decider on what remains ranks broken claims well against a frontier annotator.
  Its standing against human labels is still open.
- **Ingest triage.** Not worth it. There is too little to skip, and reading is a minority of the cost.

Two of these would make accreta call a model on its own initiative, from `lint` and from
`search_pages`. That is the reversal F-ME-05 warned about, and it deserves a decision rather than
a feature.

## Decision

**Drift at line granularity comes first, and needs no model.** Intersecting each citation's line
locator with the changed hunks is independent of everything below, and is taken on its own (#134).

**A `Judge` port in core, modelled on `SourceAdapter`.**
- It exposes a small set of typed questions:
  - `supports(claim, citedText)` → supports / contradicts / says nothing, with probabilities;
  - `stillHolds(claim, before, after)` → a probability. Proposed only, pending the audit (#154);
  - `rank(query, candidates)` → probabilities.
- Core never knows which judge it talks to. A Jev judge and a structured-output LLM judge are two
  implementations, so the vendor can be replaced, and so can a vendor that closes sign-ups.

**Off by default, and advisory only.** With no judge configured, accreta behaves exactly as today.
With one configured:
- `lint` may report `citation-unsupported`;
- `search_pages` may rerank;
- `check_drift` may order touched citations by risk.

A judge never edits a page, never bumps `last_verified_revision`, and never resolves a
contradiction. A finding it produces carries the judge, the model version and the probability,
so a reader can discount it.

**The state a judge sees is the narrowest that answers the question.** For citation support that
is the cited lines and nothing else: the study measured more context raising false "supports" on
RFCs and on code.

## Alternatives rejected

- **Leave it to the client.** It is the status quo, and it is honest. It also means lint cannot
  catch a citation whose lines do not back its claim, and search cannot recover a paraphrase: the two gaps the study found
  a model closes. Kept as the default: the port is optional.
- **Ingest triage.** The study found too little to skip and too little cost in reading.
- **Replacing the index with navigation.** A 9,842-page rebuild takes about five seconds, and 60%
  of pages in the test knowledge base had no link to reach them by.
- **Hard-wiring one vendor.** Thirteen days after launch, reached through a reseller, with direct
  sign-ups closed. The port exists so that this can change without touching core. An open-weights
  alternative with a TypeSafe-compatible API, [CLM-v0.1-8B](https://huggingface.co/Contrastive-LM/CLM-v0.1-8B),
  appeared during the study. It runs locally, so no page content would leave the machine. It is
  not measured yet.

## Consequences

- **accreta gains a network dependency and a credential**, for users who opt in. The credential
  follows the repository's rules: an environment variable, never a file in the knowledge base.
- **Page content goes to a third party** whenever a judge reads it. A private knowledge base's
  owner has to know that before configuring one, so the configuration says so in words.
- **Findings from a judge are probabilistic**, and must be reported as such, never as lint errors
  that fail CI by default.
- **`stillHolds` stays proposed until the study's audit settles the drift labels** (#152). That
  audit decides whether it is worth wiring at all. The rest is built in #153.
