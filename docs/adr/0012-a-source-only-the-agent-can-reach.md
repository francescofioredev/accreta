# ADR-0012: A source only the agent can reach is declared, not fetched

Status: accepted
Date: 2026-09-08

## Context

The corpora people ask for next are behind a connector: a wiki, a mailbox, a tracker. The
obvious adapter holds a credential and calls the provider's API, and it is the wrong one for
this project to ship.

accreta already does not read sources. The agent does, driven by the constitution, using its
own tools — that has been true since the first ingest, and ADR-0011 made the interface say so.
An adapter with a token would reverse it for exactly the sources where the reversal costs most:
a public tool would become an OAuth consumer with a token store, a rate limiter, and a
credential worth stealing, in order to fetch content it then throws away.

So accreta does not reach these sources at all. What it can still do is the part that was
always its job: know which pages cite what, and at which revision, and say precisely what has
to be checked.

## Decision

**One generic `delegated` type. No provider code anywhere.**

```yaml
id: design-docs
type: delegated
via: notion              # the connector the agent needs; accreta never interprets it
scope: |                 # prose the agent reads, and the only definition of what is in scope
  The "Design decisions" page and everything below it.
```

Notion and Gmail are declarations. Gmail costs nothing beyond a different file, which is the
test of whether the generalization is real. The price is stated in the adapter and worth
repeating: **accreta cannot check even the shape of a citation into such a source.** An
invented block id and a real one are indistinguishable here.

**Declining is raised, not returned.** `revision()` and `changedSince()` throw
`DelegatedSourceError`, carrying the connector name and the declaration's scope prose. A flag
on the adapter or a sentinel revision would both let a caller carry on as though an answer had
been given, which is the failure the whole design is avoiding — the same reasoning that made
`UnknownRevisionError` a throw rather than an empty array.

**Drift gains a fourth outcome, because the other three all lie.** `stale` claims a comparison
happened. `unverifiable` means the page records no revision. `unresolvable` means the recorded
revision is *gone* — history rewritten, re-verify from scratch — and sending a reader to redo
finished work for a reason that never happened is the most expensive of the three mistakes. So
`DriftReport.delegated` carries the connector, the scope, and the pages grouped by the revision
they are stuck at: a work order, not a verdict. `currentRevision` becomes nullable, because
there is no honest string to put there.

`lintCitations` counts these into `citationsUnchecked` rather than reporting findings, per
ADR-0011.

**`drift` exits 0; `--strict` exits 1 on anything unchecked.** Exit 0 is right because nothing
is known to be wrong. But it has a consequence that must be said in the documentation rather
than discovered in a pipeline: **a knowledge base with delegated sources cannot be gated on
drift in CI**, because the check needs an agent holding a connector. `--strict` fails on
anything unchecked — delegated pages and `unverifiable` alike — so a pipeline can demand
"nothing unverified" without anyone pretending the source was inspected.

### The conformance suite now has two tables, and that is the real cost

ADR-0002 says: if two adapters need different expectations, the abstraction is leaking. A
delegated source cannot satisfy the drift and location cases, so by that test something is
leaking, and the honest thing is to name what.

The interface has always had two halves. One is what a source can be *asked* — revisions,
changes, whether a location exists. The other is what a citation into it *renders* — the
format, the pinned revision, the unpinned sentinel. The suite was written when every adapter
did both, so it never had to distinguish them.

`EVERY_ADAPTER` now runs the provenance cases, delegated included: a citation into a Notion page
is exactly as good as one into a repository, and that is worth asserting. `QUESTIONABLE` runs
drift and `locate` over the sources accreta can interrogate. What must not happen is a third
table, or a per-adapter exception inside either — either of those would mean the split was a
convenience rather than a distinction.

## Alternatives rejected

**A credentialed adapter per provider.** Real drift detection, headless, in CI, with no agent
in the loop — genuinely better on that axis, and the reason this is "rejected for now" rather
than "wrong". Rejected because it makes a public tool a credential holder for every provider it
supports, and because the content it would fetch is content the agent is already reading.

**A hybrid: accreta holds a read-only token for `revision()` and `changedSince()` only.**
Keeps drift in CI and reads no content. Rejected: for the providers in question the token that
lists pages is the token that reads them, so "metadata only" describes accreta's restraint
rather than a smaller grant. The credential is the thing being avoided, not the byte count.

**Per-provider delegated types** — `type: notion`, `type: gmail` — with no network access, so
lint could at least check that a locator looks like a block id. Rejected: a table of providers
inside accreta that ages every time somebody else changes an id format, bought for a regex.

**Record the agent's observations**, so accreta could say "nobody has looked at this source in
21 days". Attractive, and it is transcription rather than inference, so ADR-0006 permits it.
Rejected for now: it needs a write tool and somewhere durable to keep an observation, and the
state that matters already exists as `last_verified_revision` on every page. Worth revisiting
when somebody has been surprised by a stale delegated source.

**A `delegated: boolean` on `SourceAdapter`**, letting `detectDrift` branch. Rejected: that is
`if (adapter === "fs")` with a nicer name, which ADR-0002 rejected in its own words.

**Reuse `unresolvable` and skip the fourth outcome.** No type changes at all. Rejected: it
tells the reader their recorded revision is gone. The report would be smaller and wrong.

## Consequences

- `DriftReport.currentRevision` is `string | null`. Every consumer had to decide what to print
  when nobody asked.
- A knowledge base whose sources are all delegated gets an `accreta drift` that always exits 0.
  `--strict` exists for pipelines; the README has to say which one they want and why.
- `@accreta/adapter-delegated` depends on `@accreta/core` and nothing else. If it ever grows a
  network dependency, this ADR has been abandoned rather than amended.
- A delegated source with an empty `scope` fails at construction. It is the one place accreta
  validates an adapter option, and it is validated because an empty scope tells the agent to
  check either nothing or everything.
- Gmail is now a declaration away. One thing to write down when it arrives: a mail message is
  immutable, so what changes is not a cited claim but that the thread continued. The scope
  prose has to tell the agent to look for new messages rather than for edits to a cited one.
