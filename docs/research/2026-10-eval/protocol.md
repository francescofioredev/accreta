# Agent-written pages: evaluation protocol

**Status:** pre-registered 2026-10-13, before any model run. Changing a rule below after the runs
start needs a dated note here saying what changed and why. Issue #137, launch gate #133.

## Corpus

Hono, pinned at v4.12.34 and moved to v4.13.0 (maintainer decision on #136). The knowledge base
is written by a headless agent; this protocol measures what it wrote, and does not cover how
it was written.

## Hypotheses and the #133 gate

| | Hypothesis | Measure | Floor |
| --- | --- | --- | --- |
| H1 | Footnote citations resolve | resolving footnotes / all footnotes | 0.95 |
| H2 | Drift finds the citations whose cited lines changed | recall, per citation | 0.90 |
| H3 | Answers are more accurate with the knowledge base | paired accuracy, with vs without | with > without |

**Pass rule.** H1 and H2 are met when the two-sided 95% Clopper–Pearson lower bound is at or
above the floor. A point estimate at or above the floor, with the bound below it, is "not
shown", and the launch waits. H3 is met when accuracy with the knowledge base is higher and
the one-sided exact McNemar p is below 0.05. The direction was fixed before any run, so the
test is one-sided. The launch needs all three met.

Wilson intervals are reported next to Clopper–Pearson for every rate. The gate uses
Clopper–Pearson.

## Sample sizes

From `bench/eval/lib/stats.ts`, so they can be reproduced.

- **H1:** with no failures, 72 footnotes are needed to show 0.95. With 1, 2 or 3 failures,
  110, 142 or 173.
- **H2:** with no misses, 36 positive citations are needed to show 0.90. With 1, 2 or 3 misses,
  54, 70 or 85. If the move to v4.13.0 leaves fewer positives than that, the result is
  reported as underpowered, not as a pass.
- **H3:** 30 questions. Only discordant pairs count, and fewer than 5 cannot pass. The
  knowledge base must win 5 of 5, 6 of 6, 7 of 7, 7 of 8, 8 of 9, or 9 of 10.

## Pages (H1)

- **Claim:** a sentence of prose or of a list item, with at least 5 words. Code, headings,
  tables, quotes and footnote definitions are not claims. Implemented in `lib/claims.ts`. A
  claim is cited when it references a footnote that is a citation.
- **Resolves:** `accreta lint --json` finds nothing wrong with the footnote (#123's checks).
- **Denominator:** every footnote citation. A footnote that cannot be checked counts against
  H1. For example, its source did not load, or the tree is dirty. The rate over checkable
  footnotes only is reported next to it.
- **Also reported:** the share of claims cited, lint findings per page, and the share of
  clean pages.

## Drift (H2)

The unit is the footnote citation (maintainer decision on #136, 2026-10-13). Per page is
reported as a secondary figure: a page is positive when any of its scored citations is.

**Ground truth** (`lib/drift-truth.ts`), from git only. Take the cited lines at the citation's
own revision; a footnote without a pin uses its page's `last_verified_revision`. Look for them
verbatim, as whole lines, in the file at the source's HEAD (v4.13.0). Renames are followed
with `git diff -M`.

- **Untouched:** found at the same path and the same lines.
- **Moved:** found exactly once somewhere else, in the same file or in a renamed one. This is
  a negative: the claim's evidence still exists and only the locator needs re-pinning.
- **Changed:** not found, or the file was deleted. This is the only positive.

**Prediction.** Drift flags a citation when `accreta drift --json` lists it under `in_doubt`.
It also flags every citation of a page drift judged per file or could not place. A citation
listed under `repin`, or not listed, is not flagged.

**Excluded, counted and reported:**

- the source is not git;
- the citation is unpinned and on another source's page;
- the revision is unknown to the repository;
- the locator is not a line range;
- the path is missing at its revision;
- the range runs past the end of the file;
- the block is found more than once elsewhere, so it is ambiguous.

`canonical_source` is excluded too, because the gate counts footnotes.

**Known false positive.** Drift reads a renamed file as deleted, so it flags an unchanged
block there. The fixture shows it. It lowers precision, not recall.

```
bun bench/eval/drift-score.ts --kb <kb> --to v4.13.0
```

This prints TP, FP and FN per citation and per page, precision and recall with both
intervals, and every false positive and false negative. The sources must already have
`--to` checked out.

## Answers (H3)

- 30 questions. Each has a reference answer and the evidence in the sources, both written
  before any run. The schema is in `lib/answers.ts`.
- Two arms, the same model, one session per question:
  - **with the knowledge base:** the accreta MCP server only;
  - **without:** the baseline. **Pending with the maintainer:** closed-book (no tools), or
    the repository with file tools. The runner takes it as `--baseline <arm>`, and the result
    names the arm it used.
- **Grading:** blind. Sessions are shuffled with a fixed seed under opaque item ids, and the
  arm key is in a separate file. The grader marks `correct` (1 or 0) against the reference.
  Where the answer cites anything, the grader also marks `sources_correct` (1 or 0): do the
  cited lines support the answer? The blinding is partial, because a closed-book answer cites
  nothing.
- **Reported per arm:** accuracy, the share of answers that cite anything, and the share of
  those whose sources are correct, each with intervals. Exact McNemar, one-sided and
  two-sided.
- A failed session is graded wrong, not dropped.

## Surfaces

The same tasks go to a CLI-only agent (Bash, limited to `accreta`) and an MCP-only agent (the
accreta MCP server, no built-in tools). A task succeeds when the final answer matches every
pattern in its `expect` list. Reported per arm: the success rate with intervals, and the
total tokens and turns. Reported per task: the ratio of the two arms' total tokens. Exact
McNemar on success is two-sided, because no direction is pre-registered. Surfaces are not
part of the gate.

## Cost

Cost is recomputed from each session's recorded tokens, per model, at the list prices in
`lib/cost.ts`. That table gives its source and the date it was checked; re-check it on the
day of the run. Cache writes are split between 5-minute and 1-hour rates in the proportions
the session's `usage` reports. The CLI's own figure is reported next to it.

On bench/jev's nine recorded ingest sessions, the recomputed cost matches the CLI's figure to
the cent on all nine. The test checks this.

The cost is reported per page and per resolving footnote. Following model-routing.md, a
cited claim is the unit of value, not a page.

## Runs

No model runs in part 1. Every runner works dry, from canned sessions (`--canned`), with no
network. `--live` runs `claude -p` with a budget cap per session. A live answers run refuses
any question count other than 30.
