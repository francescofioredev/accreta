# ADR-0015: Drift at line granularity, as an optional capability of the source

Status: accepted
Date: 2026-09-29

## Context

Drift works per file. A commit that touches any line of a cited file puts in doubt every page
that cites it, and on a busy repository that is most pages on most pull requests. A check that
always fires gets ignored.

The decision-model study ([#108](../research/2026-09-jev/experiments/t3-drift-triage.md))
measured the alternative on an agent-written knowledge base over got, v13.0.0 → v14.4.0.
Intersecting each cited line range with the diff's hunks leaves 114 of 683 citations touched
(17%). A frontier annotator found 8 invalidated claims, all 8 among the touched, and none in a
60-citation sample of the untouched. No model is involved.

Footnote citations are indexed since #123, so the core knows every cited range and the revision
each one names.

## Decision

**The source answers, because only the source knows what a locator means (ADR-0011).**
`SourceAdapter` gains an optional method:

```ts
touchedSince?(revision: string, path: string, locators: readonly string[]):
  Promise<Map<string, LocatorChange>>;  // touched | untouched | moved (new locator) | unknown
```

- **git** implements it with `diff -U0`. A hunk touches a range when it changes a line inside it.
  A pure insertion touches a range only when it lands strictly inside. A deleted file touches
  everything. An untouched range that shifted is `moved`, with its new locator, so the agent
  re-pins it instead of re-reading it.
- **fs** keeps no old contents and **delegated** cannot be asked, so neither implements it.
  Their reports are exactly what they were.

**The core asks once per (revision, path) and reports per citation.**
- The diff starts at the citation's own revision, because its line numbers belong to that
  revision. A citation naming none uses the page's `last_verified_revision`.
- A revision the source cannot place leaves the citation `unknown`, never `untouched`.
- `StaleRevision` gains `citations`: the citations into changed paths, each with its change.

**Nothing is cleared.** `pages` still lists every page on a stale revision.
- `pageChanges()` ranks each page `changed`, `moved`, `untouched` or `uncited`, and the CLI
  orders and explains by it.
- A page whose cited lines are untouched may rest on lines it did not cite, so it is lower in
  the list, not verified.
- The exit code is unchanged.

## Alternatives rejected

- **Keep file-level drift.** Honest, and it makes the pull request check useless on any active
  repository.
- **Intersect in the core by reading diffs.** The core would learn git's diff format, which is
  the coupling ADR-0002 exists to prevent.
- **Intersect by symbol, through a language's syntax tree.** More precise for code, but
  language-specific, and no help for prose. A line range is what every file-backed citation
  already carries.
- **Clear untouched citations outright.** 0 of 60 has a 95% interval up to 6%, not zero, and a
  claim can rest on lines it does not cite, such as a default defined elsewhere in the file.
- **Diff from the page's revision for every citation.** Wrong whenever a footnote was written at
  a different revision than the page was last verified at: the line numbers would be read
  against the wrong file.

## Consequences

- **Re-derived by the product.** On the study's three knowledge bases the product reports the
  same 114 touched citations, with 0 disagreements over 658 citations into changed files. It
  maps all 461 moved ranges to the lines the study computed, and all 8 invalidated claims land
  in `changed`.
- **The gain is at citation level, not page level, on a large jump.** Over v13 → v14.4, 36 of
  41 pages still have a touched range and 5 only need re-pinning. What shrinks is the work
  inside each page: 114 ranges to re-read instead of 658. Pull requests are smaller than a
  release, and there the page-level count should drop too. That is still to measure (#135).
- **An adapter that can diff contents should implement `touchedSince`.** One that cannot leaves
  it out; the method is optional so that `fs` and `delegated` do not have to pretend.
