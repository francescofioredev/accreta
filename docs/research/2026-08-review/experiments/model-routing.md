# Which model for ingest, drift, and lint

**Status:** designed, not run. Every number below is a cost estimate from input-side
arithmetic; nothing here reports quality, because nothing has been measured.

## Why this is not a pricing table

The tempting answer to "which model should do the ingest" is a table of list prices with a
recommendation attached. It is worthless, because it never touches the quantity that
actually varies: quality per dollar _on this task_. A model at half the price that produces
half as many valid citations is not cheaper. It is the same price with worse provenance,
and provenance is the entire product.

So the deliverable is a protocol, and a metric — **dollars per valid citation** — chosen
because a page is not the unit of value here. A cited claim is. A model that writes twice
as many pages at half the citation validity has produced the same amount of knowledge and
more liability, and dollars-per-page scores it as twice as good.

## The three phases have different shapes

**Ingest** — read the source, decide what deserves a page (the constitution says most of a
source does not, and requires two real points of contact before a concept earns one), write
cited prose without duplicating the source, and record contradictions without resolving
them. Judgement-heavy, long-context, and the phase where a mistake becomes a permanent
false claim with a citation attached to it.

**Drift re-verification** — a source moved; re-read the changed region and decide whether
the page's claims still hold. Narrower. But the cost asymmetry is severe and runs the
opposite way from intuition: a false "still valid" is silent decay that nothing will ever
flag, while a false "no longer valid" merely wastes a human's attention. The threshold must
be set on that asymmetry, never on accuracy.

**Linting** — detection is deterministic code and costs **zero** LLM tokens. The cost is in
_fixing_, and the five finding kinds differ by roughly a thousandfold. That table is the
most immediately actionable result of this review, and it is in the register.

## The setup already exists

`accreta-atlas` is a single-variable experiment someone has already assembled: eight
vendored IETF RFCs at frozen revisions, a deliberately empty `kb/knowledge/`, and RFC
7231→9110 supersession giving native contradictions to detect. The same ingest can be run
over the same corpus with different models and the outputs compared. That is rare, and it
is the reason this experiment is cheap.

## Measuring ingest

The primary metric is **citation validity**, and its first two parts are fully automatable:

- **(a)** does the cited path exist in the named source?
- **(b)** does the cited line range lie within that file?
- **(c)** does the text at those lines support the claim on the page?

(a) and (b) are a hundred lines of deterministic script. That they do not exist is itself
a finding: `lint` verifies that `canonical_source` is _present_, never that it points at
anything real, so a model can fabricate line numbers and pass lint clean.

(c) needs judgement. Sample thirty citations per run, stratified by page type so
`contradiction` pages are not swamped by `concept` pages, and have two raters score them
blind on a three-point rubric — 2 the lines state the claim, 1 related but not supporting,
0 does not bear on it. Report Cohen's kappa; below 0.6 the rubric is broken and the numbers
mean nothing yet. An LLM judge is permissible only _alongside_ human labels, reporting
agreement with them, because an unchecked judge shares the generator's failure modes — and
the specific shared bias here is judging plausibility instead of checking the line range.

Second metric: **contradiction recall and precision**, against a gold set enumerable by
hand from the corpus. Report both numbers, never a single F-score. A fabricated
contradiction is worse than a missed one, because this system's whole claim is that it does
not invent.

Three runs per model. One run cannot separate model from sampling variance.

## Measuring drift

Build the gold set by copying the corpus to a scratch source — never by editing
`kb/corpus/rfc/`, where one byte advances the revision and stales every citing page at
once. Perturb cited regions in two classes: **invalidating** (change a normative keyword
per RFC 2119, change a numeric value, reverse a condition) and **cosmetic** (reflow
whitespace, fix a typo in a non-load-bearing word). Ground truth is the perturbation class,
recorded before any model sees it.

Report the **full confusion matrix**. Never a single accuracy figure, and never an F-score
— F1 averages away exactly the asymmetry that decides the threshold. An arm is acceptable
only if its false-"still-valid" rate is below 5%; its false-"no-longer-valid" rate is a
cost line, not a gate.

One mechanical constraint shapes this task and must be stated: `changedSince` returns file
paths only, and drift never cross-references `changedPaths` against `canonical_source`. The
model is handed "this file changed", not "these lines changed", so the localisation it must
do itself is part of what is being measured.

**Note the sample size honestly.** Twenty perturbations per class cannot resolve a 5%
threshold — a single error in twenty is a point estimate of 5% with a 95% interval of
roughly 0.1% to 25%. Deciding the threshold needs about two hundred per class. Report the
underpowered result as underpowered rather than as an answer.

## What is measurable, and what is not

**Measurable now:** the (a) and (b) citation checks; per-page cost from transcripts;
contradiction recall and precision; the drift confusion matrix.

**Needs human work:** (c), and any usefulness rubric.

**Speculation, and must be labelled as such:** anything about open-weight models not
actually run — a per-token figure from a hosting provider is that provider's price, not the
model's. And any generalisation from eight RFCs to "any corpus". That is n=1 on domain, and
the domain is the easiest possible case: formally structured, stably numbered documents
written to be cited, with normative keywords defined by RFC 2119. A corpus of messy prose
will score worse on every metric here, particularly (c), where "the cited lines support the
claim" is far harder to adjudicate when the source does not make discrete claims.

## Falsification

The hypothesis is that model choice changes citation validity materially, so that
dollars-per-valid-citation ranks models differently from dollars-per-page.

It **fails** if, across three runs per arm, the arms' (a)∧(b) validity rates fall within
overlapping 95% binomial intervals _and_ the dollars-per-valid-citation ordering matches
the dollars-per-page ordering. Then model choice does not affect provenance quality on this
corpus, and the cheapest arm wins outright.

## Cost

Input is bounded and small: the whole eight-RFC corpus is roughly 423,000 estimated tokens,
so reading everything once per run is on the order of a couple of dollars at frontier rates
and cents at small-model rates. **Output and rework dominate and cannot be estimated before
the first run** — run one mid-tier arm first and budget the rest from its actual reported
usage rather than from input-side arithmetic.

The real cost is human: about two hours per run for thirty citations across two raters.
That is why (c) is sampled rather than exhaustive, and it is the reason this experiment has
not simply been run as part of the review.

Prices change. Verify every rate at the provider's own page on the day the experiment runs,
and record the date beside the figure.
