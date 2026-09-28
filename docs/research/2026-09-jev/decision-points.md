# Decision points in accreta

accreta makes two kinds of decision.

- **Code decisions are deterministic.** SQL, regular expressions, `git` and `stat` calls:
  parsing, link resolution, lint, the drift buckets, search ranking. None calls a model.
- **Judgment belongs to the external agent.** Is this claim still true? Do these lines support
  it? Does this section deserve a page? Do these sources disagree? These exist only as prose in
  the [constitution](../../../templates/constitution/base.md).

This page lists the second kind, with the question a decision model would be asked for each, and
what the experiments found. The verdicts are findings, not decisions.

## Measured

| Decision | Today | What was measured | Verdict |
| --- | --- | --- | --- |
| **Drift: does this change invalidate this claim?** | A changed file stales every page citing the source revision. The agent then re-reads the source | [T3](experiments/t3-drift-triage.md): RFC errata (1,000), claims over errata (249), claims over code (683 citations, got v13.0.0 → v14.4.0) | **The deterministic step comes first.** Intersecting cited line ranges with diff hunks clears 83% of code citations at no cost, with no wrong clear in a 60-item sample. On what remains, Jev ranks broken claims well against a frontier annotator, but the verdict against human labels is pending the audit (§ Open) |
| **Citation support: do the cited lines support the claim?** | Not checked by anyone. `lint` checks that the lines exist | [T2](experiments/t2-citation-support.md): SciFact (340 expert-labelled pairs), RFC and code citations an ingest agent wrote, each against a hard negative | **Jev ties with Haiku on SciFact at a fraction of the cost.** On code it keeps false "supports" under 5%. On RFCs and on code, **more context raises its false "supports"**: the check should see the cited lines and nothing else |
| **Ingest: which parts of a source deserve the writing model's attention?** | The agent reads everything | [T1](experiments/t1-ingest-triage.md): RFC sections (2,963), the baseline ingest's own citations (RFCs and got), cost of every ingest session | **No.** The ingest agent cites 95% of RFC sections and code holding 79% of the characters, so little can be skipped. Reading the source is a minority of ingest cost anyway. Jev ranks code no better than its length does |
| **Retrieval: find the page a query asks for** | BM25 over title, aliases and body | [T4](experiments/t4-wiki-navigation.md): 450 queries over a 9,842-page knowledge base | **Yes, on top of the index.** Reranking BM25's top 20 in one call and following typed links from the top hit both beat BM25, most where lexical search is weakest. Haiku reranks as well, at about 190× the cost. Navigating without an index cannot reach the 60% of pages that have no links |

## Analysed, not measured

| Decision | Why not measured | What the analysis says (REASONED) |
| --- | --- | --- |
| Contradiction between sources | No gold set of claim pairs yet | Pairwise over FTS-prefiltered claims, as a flag only. The constitution's third rule (record a disagreement, never pick a winner) forbids a decider from choosing one, and Jev's `choice` would invite it to |
| Page type, link field, aliases | The vocabulary is small and the agent is already writing the page | A `choice` over the configured types would work mechanically. It saves nothing: the model that writes the page already knows what it is |
| Supersession (`supersedes` / `superseded_by`) | [ADR-0006](../../adr/0006-source-obsolescence-and-authority.md) allows transcription only, never inference | A decider inferring supersession is exactly what ADR-0006 rules out |
| Text addressed to the agent inside a page (injection) | — | Jev's own documentation says adversarial content "can move the answer". Not a job for it |
| Which tool to call, which model to route to | The agent's harness, not accreta | Belongs to the client. accreta exposes tools; it does not run the loop |

## Out of scope by construction

Writing or editing pages, extracting claims, reading a whole source in one call (32k-token limit),
and comparing revisions or dates. Jev does not generate text, and its documentation says it reads
dates as text.

## Open

**Pending the maintainer's blind audit.** Two references disagree about the drift and
citation-support labels: the IETF's classification of errata, and a frontier annotator
(Claude Opus 5.5). Jev agrees with the annotator far more than with the IETF.

The audit samples are fixed in `bench/jev/data/audit/`. Until they are labelled, every figure
measured against the annotator is the annotator's judgement, not ground truth.
