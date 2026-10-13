# Agent-written pages: evaluation protocol

**Status:** pre-registered 2026-10-13, before any model run, and revised the same day after
review on #219. Changing a rule below after the first run starts needs a dated note here
saying what changed and why. Issue #137, launch gate #133.

## Corpus and order

Hono, pinned at v4.12.34 and moved to v4.13.0 (maintainer decision on #136). The steps run in
this order, and none of them starts before the one above it has finished:

1. The questions, their reference answers and their evidence are written from the sources
   alone, at v4.12.34, before the knowledge base exists. They are committed as
   `docs/research/2026-10-eval/questions.json`, and their SHA-256 is recorded here. The same
   goes for the surfaces tasks (`tasks.json`), and for the SHA-256 of the answers grading seed.
   The seed's value stays private until grading is complete.
   - questions.json SHA-256: _recorded when committed_
   - tasks.json SHA-256: _recorded when committed_
   - seed SHA-256: _recorded before the answers run_
2. The knowledge base is generated, with every source at v4.12.34.
3. H1, H3, surfaces and cost are measured, with every source still at v4.12.34
   (`pages.ts --at v4.12.34`).
4. Every source is checked out at v4.13.0, and H2 is measured (`drift-score.ts --to v4.13.0`).

## Runs

The first complete knowledge base generation and the first complete answers run are the ones
scored. Every generation and run is logged in [runs.md](runs.md), aborted ones included, with
its time, commit, model and outcome. A rerun is allowed only for a named infrastructure
failure, written in runs.md before the rerun starts. A result nobody liked is not one.

## Hypotheses and the #133 gate

| | Hypothesis | Measure | Floor |
| --- | --- | --- | --- |
| H1 | Footnote citations resolve | resolves (exists and in range) / all footnotes | 0.95 |
| H2 | Drift loses no citation whose cited lines changed | recall, per citation | 0.90 |
| H3 | Answers are more accurate with the knowledge base | paired accuracy, with vs without | with > without |

**Pass rule.**

- **H1 and H2:** met when the two-sided 95% Clopper–Pearson lower bound is at or above the
  floor. That is a one-sided 0.025 test, chosen on purpose: it is stricter than one-sided 0.05,
  because a launch claim should survive the conservative reading. A point estimate at or above
  the floor, with the bound below it, is "not shown".
- **H2's extra conditions:** "met" also needs no more than 20% of footnote citations
  excluded, and the positives spread over at least 20 distinct files. Without either, H2 is
  "not shown". Citations in one file are not independent, so a file count stands in for
  clustering.
- **H3:** met when accuracy with the knowledge base is higher and the one-sided exact McNemar
  p is below 0.05. The direction was fixed before any run, so the test is one-sided.
- The launch needs all three met. "Not shown" means the launch waits.

Wilson intervals are reported next to Clopper–Pearson for every rate. The gate uses
Clopper–Pearson.

## Sample sizes and power

From `bench/eval/lib/stats.ts`, so they can be reproduced.

- **H1:** with no failures, 72 footnotes are needed to show 0.95. With 1, 2 or 3 failures,
  110, 142 or 173.
- **H2:** with no misses, 36 positive citations are needed to show 0.90. With 1, 2 or 3 misses,
  54, 70 or 85. A result with fewer positives than that is reported as underpowered, not as a
  pass.
- **H3:** 30 questions, and only discordant pairs count. `mcnemarThreshold(d, 0.05, "one")`
  gives the knowledge-base wins needed to pass. Fewer than 5 discordant pairs cannot pass. The
  needed wins are 5 of 5, 6 of 6, 7 of 7, 7 of 8, 8 of 9, or 9 of 10.
- **H3 power** (`mcnemarPower`):
  - Suppose 20% of questions are right only with the knowledge base and 5% only without.
    Then the power at 30 questions is 0.34.
  - 80% power is first reached at 74 questions.
  - So at realistic effects, "not shown" is the likely outcome at n = 30. The number stays at
    30, as #137 sets it, and the result will be read that way.

## Pages (H1)

- **Claim:** a sentence of prose or of a list item, with at least 5 words. Code, headings,
  tables, quotes and footnote definitions are not claims (`lib/claims.ts`). A claim is cited
  when it references a footnote that is a citation.
- **Resolves (exists and in range):** `accreta lint --json` finds nothing wrong with the
  footnote (#123's checks). The cited path exists and the cited range lies inside the file.
  This says nothing about whether the lines support the claim.
- **Denominator:** every footnote citation. A footnote that cannot be checked counts against
  H1, for example because its source did not load or the tree is dirty. The rate over
  checkable footnotes only is reported next to it.
- **Also reported:** the share of claims cited, lint findings per page, and the share of
  clean pages.
- **Secondary, not in the gate: support audit.**
  - 60 cited claims are sampled with a seeded shuffle.
  - Two graders independently judge whether the cited lines state the claim.
  - Reported: the supported share with Clopper–Pearson intervals, and Cohen's kappa.
  - Disagreements are settled blind.
  - The supported share is also the support rate that cost per supported claim uses.

## Drift (H2)

H2 tests one thing: whether drift loses a citation whose cited lines changed. It does not test
whether a claim is still true. A claim can go stale through lines it never cited, and no
per-citation check can see that.

The unit is the footnote citation (maintainer decision on #136, 2026-10-13).

**Ground truth** (`lib/drift-truth.ts`), from git only.

- Take the cited lines at the citation's own revision. A footnote without a pin uses its
  page's `last_verified_revision`.
- Look for them verbatim, as whole lines, in the file at the source's HEAD (v4.13.0).
- Follow renames with `git diff -M`.

The outcomes:

- **Untouched:** found at the same path and the same lines.
- **Moved:** found exactly once somewhere else, in the same file or in a renamed one. This is
  a negative: the evidence still exists, and only the locator needs re-pinning.
- **Changed:** not found, or the file was deleted. This is the only positive.
- **Whole-file citations:** a citation with no locator cites its whole file. It is untouched
  only if the file is unchanged.

**Prediction.** Drift flags a citation when `accreta drift --json` lists it under `in_doubt`.
It also flags every citation of a page that drift judged per file or could not place. A
citation listed under `repin`, or not listed, is not flagged. Citations are matched on source,
page, footnote, path and locator.

**Excluded, counted and reported:**

- the footnote is not a citation (no source or no path);
- the source is not git;
- the citation is unpinned and on another source's page;
- the revision is unknown to the repository;
- the locator is not a line range;
- the path is missing at its revision;
- the range runs past the end of the file;
- the block occurs more than once in its own file at its revision ("ambiguous at its
  revision"), because an edited block with a surviving twin would read as moved;
- the block is found more than once elsewhere at HEAD.

`canonical_source` is excluded too, because the gate counts footnotes.

**Reported next to H2, none of them in the gate:**

- recall with every exclusion counted as a miss;
- the share of citations excluded;
- the number of distinct files among the positives;
- per page as "any-hit": a page is positive when any of its scored citations is;
- a trivial baseline, which flags every citation whose file changed at all. Its precision is
  set against drift's. Its recall is 1 by construction, because every changed block is in a
  changed file;
- every single-line "moved" verdict, listed for audit by hand, because one matching line is
  weak evidence.

**Defects.** A moved citation that drift neither flags nor lists for re-pinning is a defect.
Defects are reported whatever the gate says.

**Staleness audit, secondary.**

- 30 claims are sampled from pages with at least one changed source file but no flagged
  citation.
- Two graders judge at v4.13.0 whether each claim still holds.
- Reported: the stale share with Clopper–Pearson intervals, next to H2.

**Known limitations.**

- Drift reads a renamed file as deleted, so it flags an unchanged block there. That lowers
  precision, not recall.
- `git diff -M` pairs a rename only above 50% similarity. Below that, the file reads as deleted
  and the truth says "changed", even if the block survived. Such cases show up among the false
  positives, and are checked there by hand.

## Answers (H3)

- **Questions:** 30, written and hashed as in step 1. The schema is in `lib/answers.ts`.
- **Arms:** the same model in both, one session per question.
  - **With the knowledge base:** the accreta MCP server only.
  - **Without:** the baseline. **Pending with the maintainer:** closed-book (no tools), or the
    repository with file tools. The runner takes it as `--baseline <arm>`, and the result
    names the arm it used.
- **Blinding.**
  - Sessions are shuffled with the seed under opaque item ids.
  - The sheets go to `--out`. The arm key and the raw sessions go to `--key-out`, a separate
    directory.
  - Graders get only the sheets.
  - Nobody opens the key directory until every sheet is complete.
  - The blinding is partial, because a closed-book answer cites nothing.
- **Grader role:** a person who neither wrote the questions nor ran the sessions.
- **Pass 1, correctness.**
  - The answer is shown with its `Sources:` block removed.
  - Two graders each mark `correct` (1 or 0) against the reference, independently.
  - Cohen's kappa is reported.
  - Disagreements go to a third, blind pass (`disagreements`). Its marks settle them.
- **Pass 2, sources.**
  - Only after pass 1 is complete: for every answer that cites anything, mark
    `sources_correct` (1 or 0). Do the cited lines support the answer?
  - A cited knowledge-base page counts as correct only when its footnote for that claim
    points at source lines that support the answer.
- **Reported per arm:** accuracy, the share of answers that cite anything, and the share of
  those whose sources are correct, each with intervals. Exact McNemar, one-sided and
  two-sided.
- A failed session is graded wrong, not dropped.

## Surfaces

- **Tasks:** 20, written from the knowledge base's page list before any surfaces run, and
  hashed as in step 1.
  - Each task has one checkable answer.
  - It has `expect` patterns the final answer must all match, and `reject` patterns it must
    not match.
  - Patterns are written with the task, never after a run.
- **Arms:** a CLI-only agent (Bash, limited to `accreta`) and an MCP-only agent (the accreta
  MCP server, no built-in tools).
- **Reported:**
  - the success rate per arm, with intervals;
  - total tokens and turns;
  - the token ratio, both of the totals and as a geometric mean of the per-task ratios;
  - exact McNemar on success, two-sided, because no direction is pre-registered.
- **Fewer than 6 discordant tasks:** no exact test can reject, so success is reported as
  descriptive only.
- Surfaces are not part of the gate.

## Cost

- Cost is recomputed from each session's recorded tokens, per model, at the list prices in
  `lib/cost.ts`. That table gives its source and the date it was checked; re-check it on the
  day of the run.
- Cache writes are split between the 5-minute and 1-hour rates in the proportions `usage`
  reports. The split applies only to the model `usage` describes. Other models' writes are
  priced at 5 minutes.
- Writes with no split are an error, not a guess.
- `inference_geo: "us"` costs 1.1x on Claude 4.6 and later models. An unknown geography is an
  error.
- Haiku 5.5 is priced at its tier for prompts up to 100K tokens. The tier above is set per
  request, and aggregated `modelUsage` cannot apply it.
- The CLI's own figure is reported next to the recomputation. Agreement validates the token
  accounting only, not the prices. It matches to the cent on bench/jev's nine recorded ingest
  sessions, and on #136's dry-run ingest ($2.376).
- **Reported per:** page, resolving footnote, cited claim, and supported claim (from the
  support audit's rate). Following model-routing.md, a supported claim is the unit of value.

## Commands

```
bun bench/eval/pages.ts --kb <kb> --at v4.12.34
bun bench/eval/drift-score.ts --kb <kb> --to v4.13.0 [--citations]
bun bench/eval/answers.ts run --questions q.json --arms arms.json --baseline <arm> \
  --out <sheets> --key-out <key> (--canned c.json | --live --seed <s> --seed-sha256 <hex> \
  --questions-sha256 <hex>)
bun bench/eval/answers.ts disagreements --first a.csv --second b.csv --key key.json --out settle.csv
bun bench/eval/answers.ts score --first a.csv --second b.csv [--settled settle.csv] \
  --sources s.csv --key key.json --baseline <arm>
bun bench/eval/surfaces.ts --tasks t.json --arms arms.json (--canned c.json | --live)
bun bench/eval/cost.ts --sessions <file> --kb <kb> --at v4.12.34 [--support-rate <0..1>]
```

Each command runs with `--conditions=@accreta/source`. No model runs in part 1. Every runner
works dry from canned sessions (`--canned`), with no network. `--live` runs `claude -p` with a
budget cap per session. A live run refuses a question or task count other than the registered
one, and a seed or questions file whose hash is not the registered one.
