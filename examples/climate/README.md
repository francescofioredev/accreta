# Demo: a knowledge base over scientific reports

Ten pages compiled from two sources, with provenance on every claim and drift detection
against both.

The corpus is deliberately not code. It has no symbols, no call graph, and no imports — the
properties the original system's page types were built around. If page schema, provenance and
drift detection work here, the `SourceAdapter` abstraction is real rather than decorative.

## Run it

```bash
cd examples/climate
bun run ../../packages/cli/src/main.ts reindex
bun run ../../packages/cli/src/main.ts lint
bun run ../../packages/cli/src/main.ts drift
```

Expected:

```
Indexed 10 pages and 27 links in 37ms.
10 page(s) checked, nothing to report.
ipcc-ar6-wg1 @ a80a1b6… up to date
noaa-gml @ a80a1b6…     up to date
```

Then query it:

```bash
… canonical "ECS"                                    # alias → the page that defines it
… consumers findings/permafrost-feedback-gradual     # who disputes this finding
… search "thermokarst"
```

## The sources are stand-ins, and say so

`sources/` holds short paraphrases written for this demo, not the real reports. Every figure
is approximately right and attributed to the body that published it, so citations point
somewhere meaningful — but they are not quotable and `sources/README.md` says so on the page.

A demo of a provenance tool that fabricated its sources without admitting it would be
self-refuting.

## What to look at

**[`knowledge/contradictions/permafrost-feedback-strength.md`](knowledge/contradictions/permafrost-feedback-strength.md)**
is the page that matters most. Two sources give values differing by a factor of three. The
page records the disagreement, cites both sides, and explains that the gap is a difference in
which processes are modelled rather than a measurement dispute — and then stops.

It does not average them. It does not prefer the more recent. It does not quietly cite one.
Producing a single number would present a scope difference as a settled quantity, and
[`findings/carbon-budget.md`](knowledge/findings/carbon-budget.md) depends on this input —
so anyone using that budget needs to know it is contested.

**Every page carries a real citation.** Not a filename: a source, a path, a line range, and
the commit the claim was verified against. The line ranges resolve to text that supports the
claim; that was checked rather than assumed.

**The vocabulary is not code's.** `accreta.config.yaml` declares `source`, `concept`,
`finding`, `method`, `contradiction`, `synthesis`, and link fields `cites`, `contradicts`,
`supports`, `supersedes`. No `module`, no `api`, no `endpoint`.

## Why the sources use the git adapter

An `fs` revision is a hash of modification times, and modification times do not survive a
clone. Pinning one here would mean every fresh checkout produced a different revision and
every page reported as `unresolvable` — a demo that is broken on arrival for everyone but its
author.

This repository is a git repository, so the sources have real commit SHAs and the provenance
verifies for anyone who clones it.

The `fs` adapter is exercised in [`bench/corpus`](../../bench/corpus) instead, where the
index is rebuilt in-process and mtime revisions are exactly right.

## Scope

This is a demo, not a climate project. Ten pages, no original analysis, every claim pointing
back at its source.
