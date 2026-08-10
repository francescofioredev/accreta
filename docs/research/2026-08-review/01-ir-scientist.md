# Retrieval, and whether ADR-0001's measurement can support its conclusion

> One of six independent reviews, August 2026. Each reviewer worked from a single
> disciplinary lens with no sight of the others' work; an adversarial verifier then
> checked every citation and every `file:line` and rejected what did not survive.
> **Read `00-register.md` for what was confirmed** — this report is the raw finding,
> before verification.
>
> **Owns:** Q1 (retrieval), and the standing attack on ADR-0001
> **Agent:** `.claude/agents/accreta-ir-scientist.md`
>
> Evidence grades: **MEASURED** (ran it, with numbers and command) ·
> **CITED** (a source with the specific result relied on) ·
> **REASONED** (an argument from the code, the weakest grade).

## F-IRS-01: The paraphrase-at-50% result has a 95% CI of 12-88% and cannot discriminate between "lexical search is fine" and "lexical search is broken"
- Severity: high
- Evidence: MEASURED. `bun run bench/search-bench.ts` on Apple M3, macOS 26.5.2, bun 1.3.13 reproduces ADR-0001 exactly: overall recall@1 85%, recall@5 90%, MRR 0.867, paraphrase n=6 recall@1 50%. Clopper-Pearson exact 95% intervals by exact binomial tail bisection:
  | reported | k/n | point | Wilson 95% | Clopper-Pearson 95% |
  | overall recall@1 | 17/20 | 85.0% | 64.0-94.8 | 62.1-96.8 |
  | overall recall@5 | 18/20 | 90.0% | 69.9-97.2 | 68.3-98.8 |
  | exact-term r@1 | 6/6 | 100% | 61.0-100 | 54.1-100 |
  | alias r@1 | 5/5 | 100% | 56.6-100 | 47.8-100 |
  | paraphrase r@1 | 3/6 | 50.0% | 18.8-81.2 | 11.8-88.2 |
  | conceptual r@1 | 3/3 | 100% | 43.9-100 | 29.2-100 |
  Power (normal approx, alpha=.05, two-sided, 80% power): distinguishing paraphrase 50% from 70% needs n~47 in that class; bench has 6. Distinguishing overall 85% from 95% needs n~78; bench has 20.
  CITED - Buckley & Voorhees, "Evaluating Evaluation Measure Stability", SIGIR 2000, https://dl.acm.org/doi/10.1145/345508.345543 - validates the rule of thumb that a retrieval experiment needs at least 25 topics, and 50 is better; shows precision@30 carries roughly twice the error rate of average precision. Every class in bench/queries.json is n=3 to n=6. Setting differs (TREC ad-hoc, hundreds of thousands of documents, multiple systems) but transfers in the direction that matters: topic count, not corpus size, drives measurement stability.
- Where: bench/queries.json, docs/adr/0001-lexical-search-first.md:44-56
- Failure scenario: ADR-0001 states reopen-trigger #1 fires if "paraphrase recall@1 stays below ~70%". A future maintainer runs a larger benchmark, gets 65%, concludes the trigger fired - but 65% is inside the current 12-88% interval, so nothing was learned and semantic-search work is authorized on noise. Symmetric failure is worse: 75% and the gap is declared closed by a measurement that never had power to disconfirm.
- Falsifiable proposal: State intervals inline in ADR-0001 and bench/README.md; restate trigger #1 as a lower-confidence-bound test: "the 95% lower bound of paraphrase recall@1 is below 70% on >=50 paraphrase queries." Proven wrong if 50 paraphrase queries still leave the CI too wide to evaluate the trigger - which would mean variance is corpus heterogeneity, not binomial sampling error, and the fix is stratification.
- Cost to verify: 0h for the arithmetic; 6-10h for the larger query set.
- Confidence: high.

## F-IRS-02: ADR-0001's baseline argument rests on a factual error - FTS5 `ORDER BY rank` already IS BM25
- Severity: medium
- Evidence: CITED + MEASURED. SQLite FTS5 docs, https://www.sqlite.org/fts5.html: "in a full-text query, column rank contains by default the same value as would be returned by executing the bm25() auxiliary function with no trailing arguments." FTS5 multiplies BM25 by -1 so better matches sort numerically lower, which is why bare ascending `ORDER BY rank` is correct.
  MEASURED - rebuilt bench/corpus into a scratch database, re-ran all 20 queries under four orderings:
    raw rank (shipped)             r@1 17/20 (85%)  r@5 18/20  MRR 0.867
    bm25(pages_fts,10.0,5.0,1.0)   r@1 17/20 (85%)  r@5 18/20  MRR 0.867
    bm25(pages_fts, 3.0,3.0,1.0)   r@1 17/20 (85%)  r@5 18/20  MRR 0.867
    bm25(pages_fts) unweighted     r@1 17/20 (85%)  r@5 18/20  MRR 0.867
  Identical to three decimals in every class. Field weighting title x10/alias x5/body x1 changes nothing on this corpus.
  CITED - Robertson & Zaragoza, "The Probabilistic Relevance Framework: BM25 and Beyond", FnTIR 3(4), 2009, https://dl.acm.org/doi/abs/10.1561/1500000019 - develops BM25F, which combines term frequencies across weighted fields BEFORE saturation. FTS5's bm25() applies per-column weights to independently-computed column contributions and does NOT implement BM25F.
- Where: packages/core/src/query/search.ts:60 (`ORDER BY rank`); the word "BM25" appears nowhere in docs/adr/ or the query layer.
- Failure scenario: A reviewer sees no bm25() call and concludes accreta ships an unranked baseline, then either files work to "add BM25" (a no-op that will measure as zero improvement) or argues ADR-0001 compared dense retrieval against a strawman. Both wrong, and nothing in the repo corrects them.
- Falsifiable proposal: Comment at search.ts:60 recording that `rank` is FTS5's BM25 with default k1=1.2/b=0.75 and unit column weights, that negation is why ascending is correct, and that field weighting measured zero effect on 8 pages. Do NOT add field weights on this evidence. Proven wrong if a few-hundred-page corpus shows weighting moving recall@1 by more than the CI half-width.
- Cost to verify: 1h.
- Confidence: high for the factual claim and the null result; LOW for whether the null generalizes - 8 pages is the regime where weights cannot matter.

## F-IRS-03: The alias result - the ADR's load-bearing finding, quoted to users in two shipped artifacts - is three queries flipping, at p=0.25
- Severity: high
- Evidence: MEASURED. Reproduced the "before" condition by rebuilding the bench index with the aliases column blanked, title and body intact:
    ALIASES BLANKED, raw rank      r@1 14/20 (70%)  r@5 16/20  MRR 0.742
      alias   n=5  r@1 2/5 (40%)  MRR 0.500
  Matches ADR-0001's reported before-figures exactly (70%/40%/0.742). Per-query alias ranks:
    q07 "climate forcing"      blanked 2  -> indexed 1
    q08 "ECS"                  blanked not found -> indexed 1
    q09 "planetary reflectivity" blanked 1 -> indexed 1
    q10 "thermal inertia"      blanked not found -> indexed 1
    q11 "remaining carbon budget" blanked 1 -> indexed 1
  Exactly 3 of 20 queries change rank. Two alias queries already worked without the column. McNemar exact two-sided p = 0.25 (one-sided 0.125). Unpaired Fisher on the alias class, 5/5 vs 2/5, p = 0.167. Intervals: before 2/5 CP 95% 5.3-85.3%; after 5/5 CP 95% 47.8-100%. They overlap across most of their range.
- Where: docs/adr/0001-lexical-search-first.md:58-77; propagated verbatim to users at templates/constitution/base.md:90 and skills/accreta-setup/SKILL.md:92; also asserted in the schema comment at packages/core/src/index-db/schema.sql.
- Failure scenario: The claim ships inside the constitution every accreta user's agent reads as its operating program. An agent reads "indexing aliases moved alias-query recall from 40% to 100%" and treats alias authoring as a measured high-return activity. The measurement behind it is two queries that found nothing and one that moved from rank 2 to rank 1.
- Falsifiable proposal: (1) In the ADR, report "3 of 20 queries changed rank; 2 alias queries retrieved nothing without the column" alongside the percentages, with the McNemar p. (2) In base.md and SKILL.md, drop the percentages and keep the mechanism, which is solid: a name a page declares but never uses in its body is unreachable unless aliases are indexed. That statement is deterministic and needs no statistics. Proven wrong if >=50 alias queries on a few hundred pages hold the effect at the claimed magnitude with a CI excluding 20pp.
- Cost to verify: 2h to reproduce; 8-12h for the larger set.
- Confidence: high.
- CREDIT: The DECISION ADR-0001 reached is correct, and for a better reason than the statistics it cites. The mechanism is deterministic and needs no n: a page declaring aliases:["ECS"] where "ECS" appears nowhere in title or body is unreachable by any lexical query using that name. q08/q10 returning literally nothing demonstrates it. The ADR also correctly diagnosed that the first run's 40% was an index defect masquerading as evidence for embeddings.

## F-IRS-04: The judgments are single-assessor, author-as-assessor, and single-relevant-document - and one query demonstrably has two relevant pages
- Severity: medium
- Evidence: REASONED, with one MEASURED counterexample. THIS FINDING IS REASONED AND SAYS SO.
  bench/queries.json states its own design: "Each query names the one page a correct system should return first", judgments "written by hand against corpus/knowledge". Corpus and judgments are in the same commit lineage, authored together.
  MEASURED counterexample: q13 "how much sunlight bounces back to space", judged relevant to concepts/albedo.md, is scored a complete miss (not in top 10). What it returns at rank 1 is synthesis/energy-balance.md, whose body reads "governs how much sunlight is absorbed in the first place". A second assessor could readily judge that relevant. If they did, paraphrase recall@1 becomes 4/6 (66.7%) and overall 18/20 (90%) - from ONE judgment call. Note albedo.md says "reflected", "reflects", never "bounces".
  CITED - Voorhees, "Variations in relevance judgments and the measurement of retrieval effectiveness", SIGIR '98 and IP&M 36(5):697-716, 2000, https://www.nist.gov/publications/variations-relevance-judgments-and-measurement-retrieval-effectiveness - found different assessors' judgment sets produce very high correlations among the resulting SYSTEM RANKINGS despite substantial per-document disagreement. The transferable half is the RELATIVE one, and accreta cannot use it: ADR-0001 reports an ABSOLUTE score for one system against a fixed threshold. Absolute scores are exactly what Voorhees shows is not stable under assessor variation.
  CITED - Cranfield paradigm (Cleverdon, Aslib Cranfield Research Project, 1966; "The Cranfield tests on index language devices", Aslib Proceedings 19(6), 1967) established the test-collection method and its assumptions: relevance topical, independent per document, complete over the collection. Cranfield could assume completeness because its collection was small enough to judge exhaustively. bench/ has 8 pages and 20 queries, so exhaustive judgment (160 pairs) is AVAILABLE here and was simply not done.
- Where: bench/queries.json:2, bench/corpus/knowledge/, bench/queries.json q13
- Failure scenario: Single-relevant-document is defensible at 8 pages only by luck, and q13 shows the luck ran out. At 1,000 pages it is not defensible: a knowledge base whose purpose is compiling INTERLINKED pages will by construction have clusters all partly relevant to one question. A benchmark naming one and scoring the other four as failures reports recall@1 falling as the corpus grows, and a maintainer reads that as retrieval degrading with scale when what degraded is the judgment procedure - firing trigger #1 and authorizing an embedding pipeline to fix a measurement artifact.
- Falsifiable proposal: Graded, exhaustively-pooled judgments for the 8-page corpus - all 160 pairs, 0/1/2 - and report nDCG@5 alongside recall@1. At 8 pages this costs one sitting. For larger corpora, pool the top-10 of every variant and judge the pool, with a second assessor on 20% so inter-assessor agreement is reported rather than assumed. Proven wrong if exhaustive judgment finds exactly one relevant page for >=19 of 20 queries and nDCG@5 ranks variants identically to recall@1.
- Cost to verify: 3-4h for the 160-pair judgment; needs a second assessor.
- Confidence: medium. The q13 counterexample is solid; the claim that multi-relevance worsens at 1,000 pages is an argument from corpus design, not a measurement.

## F-IRS-05: Two of ADR-0001's three reopen triggers cannot be evaluated today, and the one that can is measured by a benchmark too small to evaluate it
- Severity: medium
- Evidence: REASONED. THIS FINDING IS REASONED.
  Trigger 1 ("paraphrase recall@1 stays below ~70% on a corpus of a few hundred pages"): no few-hundred-page judged corpus exists. bench/corpus has 8 pages; scale-bench.ts generates 100/1000/10000 but with generated bodies and NO relevance judgments, so it cannot compute recall at all - verified: it reports build time, index size, and query latency only. And per F-IRS-01, at current n the threshold sits inside the CI.
  Trigger 2 ("a real user's queries look like the paraphrase class more often than this benchmark assumes"): no query log exists anywhere in either repository. No instrumentation, no counter, no artifact could ever cause it to fire. Unfalsifiable as written.
  Trigger 3 ("a cheap local embedding provider makes the offline guarantee survivable"): "cheap" and "survivable" have no threshold.
- Where: docs/adr/0001-lexical-search-first.md:117-128
- Failure scenario: The ADR presents these as "concrete triggers, so this is not relitigated on taste". None can return an answer, so the decision is relitigated on taste anyway while appearing trigger-governed.
- Falsifiable proposal: Restate all three mechanically. T1: "on a judged corpus of >=200 pages with >=50 paraphrase queries, the 95% lower bound on paraphrase recall@1 is below 70%". T2: "over >=500 logged search_pages calls from real agent sessions, >=30% classify as paraphrase under a stated rubric". T3: "a local model under 500MB, on CPU, embeds a 1,000-page corpus in under 60s on the reference machine, and hybrid beats lexical by more than the CI half-width on T1's corpus."
- Cost to verify: 0h to confirm they are unevaluable; 20-30h to build what T1 needs.
- Confidence: high that they are not operational; medium on the specific replacement thresholds.

## F-IRS-06: There is zero evidence about the query distribution an agent actually produces, and the MCP tool description steers agents away from the one thing the index does well
- Severity: high
- Evidence: MEASURED (absence, exhaustively checked) + REASONED.
  Complete inventory of agent-query evidence in both repositories:
  - accreta-atlas/scripts/query-smoke.ts: `const EXPECTATIONS: Expectation[] = []`. EMPTY. Its guard fails the build if pages exist with no expectations; kb/knowledge/ is empty by design so it passes via the pageCount===0 branch. Runs in CI twice and asserts nothing about retrieval.
  - accreta-atlas/scripts/mcp-smoke.ts:75: one hardcoded liveness probe, search_pages({query:"protocol",limit:5}).
  - accreta-atlas/docs/findings.md: records drift bugs, init, the write gate. NO retrieval findings.
  That is the entire corpus of agent query evidence: one hand-written string.
  REASONED and load-bearing: packages/mcp-server/src/server.ts:44 describes search_pages as "Full-text search across the knowledge base (title and body)". The index searches title, ALIASES, and body (schema.sql; build.ts inserts the aliases column). The description omits aliases - precisely the field ADR-0001 identifies as the curated corpus's distinguishing signal and that F-IRS-03 confirms is the difference between finding "ECS" and finding nothing.
- Where: packages/mcp-server/src/server.ts:44; accreta-atlas/scripts/query-smoke.ts:29; accreta-atlas/scripts/mcp-smoke.ts:75
- Failure scenario: (1) ADR-0001 generalizes from 20 human-written queries to the behaviour of its actual consumer, an LLM, with no observation of that consumer, while trigger #2 explicitly flags the class mix as "the assumption most likely to be wrong" and provides no way to check it. (2) An agent reads "title and body", believes alias lookup is unsupported, and either avoids short-name queries or expands them to compensate - producing exactly the paraphrase-shaped traffic ADR-0001 is least equipped to serve, which the benchmark would never see.
- Falsifiable proposal: (a) Correct the description to "title, declared aliases, and body" - one line, no behaviour change, makes it match schema.sql. (b) Add opt-in query logging behind ACCRETA_LOG_QUERIES (off by default, query text and result count to a local file, nothing leaving the machine), run one real ingest in accreta-atlas, classify against the four classes. Proven wrong if the logged distribution matches the bench's mix within sampling error - which would retire trigger #2 by confirming the guess.
- Cost to verify: (a) 15 minutes. (b) 4-6h. Cheapest high-value measurement available to the project.
- Confidence: high on the absence (enumerated exhaustively) and on the description/schema mismatch; medium on the behavioural consequence.
- CREDIT: the empty EXPECTATIONS list with a guard that hard-fails once pages exist is genuinely good design a reviewer would be tempted to score as a gap. It is a pre-committed obligation that makes the hole impossible to forget.

## Experiment card: A judged corpus with enough topics to decide the semantic-search question
- Question: On a corpus at accreta's target scale, is the paraphrase gap large enough and stable enough to justify an embedding index - or does it close with corpus-side fixes that cost far less?
- Hypothesis: Paraphrase recall@1 on 200-400 judged pages lands in 55-75% with its 95% lower bound BELOW 70%, firing restated trigger #1. Secondary: adding one alias per page for its most common paraphrase closes >=half the gap.
- Method: (1) Build the corpus in accreta-atlas from the 8 vendored RFCs, 200-400 pages - doubles as the missing technical-corpus demo. (2) ACCRETA_LOG_QUERIES on during ingest; the agent's own queries become the seed pool, the only way to get non-human-shaped queries. (3) >=200 queries, >=50 per class, recording which came from which origin. (4) Judge by pooling top-10 of every variant, graded 0/1/2, second assessor on 20%, report Cohen's kappa. (5) Report per-class with Clopper-Pearson intervals.
- Metric: nDCG@5 primary, recall@1 and MRR alongside for continuity. nDCG because it admits graded and multiple relevance, which F-IRS-04 shows this corpus has, and because recall@1 discards the difference between "relevant at rank 2" and "absent".
- Falsification criterion: refuted if paraphrase nDCG@5's 95% lower bound is at or above 70%. Secondary refuted if alias enrichment moves it by less than the CI half-width. Both failing together - a real gap aliases cannot close - is the only result that authorizes building semantic search.
- Cost: 20-30h agent ingest; 8-12h judging; 3-4h second assessor; ~2h engineering. Few million tokens. No embedding API needed - the experiment decides whether to buy one.
- Not measured: between-variant comparison power (needs ~388 queries to detect 10pp at a 50% baseline); corpora above ~1,000 pages; whether RFC-shaped prose generalizes; anything about dense retrieval itself.

## What I could not establish
- The actual query distribution an agent produces. The evidence does not exist. Needs query logging plus one ingest session (~4-6h); everything needed to host it is already in accreta-atlas.
- Whether the paraphrase gap survives at scale. scale-bench generates corpora but no judgments. I measured search latency 0.30ms (100 pages) / 0.94ms (1,000) - sublinear, ADR-0001's PERFORMANCE case is in good shape - but latency is orthogonal.
- Whether the alias effect is the size ADR-0001 claims. Established it is 3 of 20 at McNemar p=0.25 and the mechanism is real; magnitude at n=5 has CIs of 5.3-85.3% before and 47.8-100% after.
- Whether field weighting helps. Measured exactly zero effect on 8 pages, but that is the regime where weights cannot matter. The null is real; the generalization is not.
- Inter-assessor agreement. One counterexample (q13) is not a rate. Needs a second human, ~3h over 160 pairs.
- Whether Voorhees transfers in the direction I claim. Verified the paper exists and its headline finding. Could NOT retrieve full text - the one open PDF mirror serves an expired certificate - so I could not confirm the Kendall tau values or the authors' own caveats about absolute vs relative. My argument that it does NOT license absolute-threshold triggers follows from the abstract and NIST's summary, and is MY INFERENCE, not the paper's wording. Treat that inferential step as REASONED even though the citation is CITED.
- The precise BEIR dataset count where BM25 beats dense retrieval. Confirmed the paper (Thakur et al., NeurIPS 2021 Datasets & Benchmarks, arXiv:2104.08663), the 18-dataset scope, and the verbatim abstract claims that BM25 is "a robust baseline" and dense retrievers "often underperform other approaches". Could NOT extract a per-dataset win count - the PDF returned unparseable. I cite only the abstract and make no numeric claim. BEIR supports "lexical is a strong zero-shot baseline" but does not by itself support "lexical is sufficient here", because accreta's corpus is curated in-domain rather than zero-shot - a difference that makes BEIR MORE favourable to accreta, not less.

SUMMARY: the decision is right and I would not overturn it. The strongest argument for it is not the one the ADR makes. The ADR argues from percentages its n cannot support; the durable argument is deterministic - an undeclared alias is unreachable, curated metadata is free signal, and no embedding pipeline is justified before the cheap corpus-side fix has been tried. ADR-0001 already names that alternative and defers it. Promote it from deferred to next, and stop shipping the percentages to users while the mechanism is sound but the magnitude is not measured.
