# ADR-0006: Obsolescence is declared, never inferred, and a contested page says so

Status: proposed
Date: 2026-08-10

## Context

`supersedes` and `superseded_by` ship in the default vocabulary, in both presets, and in the
constitution, which tells users that "a reader arriving from an old reference needs to land
somewhere that tells them it was superseded". Nothing in `packages/core` interprets either
field. They are ordinary links whose names happen to sound meaningful — verified by grep, and
by building a knowledge base where one page declares itself superseded by another and watching
`lint` return zero findings.

The documentation makes a promise on the code's behalf that the code never made.

Underneath that is a structural fact that decides the shape of any fix. **A document declares
what it obsoletes; it can never declare what obsoletes it**, because its successor had not been
written yet. RFC 7231 contains no reference to RFC 9110 — the fact lives only in 9110's own
header and in an external registry. So the obsolescence of a source is knowable only from a
document that is *not that source*, which means per-source drift detection can never find it,
however good the adapter becomes.

That is not an implementation gap. Drift compares a recorded revision against the current one
and asks what changed; a source that has been superseded without changing a byte produces an
empty diff, correctly. The atlas corpus makes this vivid: RFC 7231 is frozen forever, so `drift`
will report it green forever, while the document has been obsolete since 2022. The test bed
chosen to prove drift works is the sharpest demonstration of what drift cannot see.

There is a second failure one layer up. A knowledge base can record a contradiction perfectly —
a `contradiction` page, a `contradicts` edge, both sides cited — and the agent reading it will
never know. `search_pages` returns the superseded page with no signal that it is contested;
`get_page` returns its frontmatter but not the inbound edges that contest it; `find_canonical`
returns it under a description promising the page that *authoritatively* defines the term. The
constitution's third rule binds the author not to pick a winner. The interface picks one anyway.

## Decision

**Three predicates, kept distinct.** *Changed* is byte-level and drift owns it. *Obsolete* is a
successor relation and is orthogonal to change. *Conflicting* is two sources making incompatible
claims. accreta implements the first, and its vocabulary implies all three.

**Obsolescence is declarative, never inferred.** Four authorities can assert that a source is
obsolete, and they are not equal:

1. the publisher declares it, in the successor document — strongest, in-band, a recorded fact;
2. an external registry declares it — strong, but out-of-band, and the registry is itself a
   source that drifts;
3. the user declares it, in frontmatter or configuration — weaker, but legitimate, because a
   human asserted it and the assertion is attributable;
4. the agent infers it from reading — **forbidden**, because it is the agent deciding on its own
   authority that one source replaced another, which is picking a winner with extra steps.

An agent may *transcribe* authority 1 — reading `Obsoletes: 7231` in RFC 9110's header and
recording it with a citation is transcription, not inference. The distinction is whether a line
number can be attached.

**A contested page says so, and nothing more.** `SearchHit` and `PageRecord` gain a `contested`
field, populated from the already-indexed `links` table: the page's own `superseded_by`, plus
inbound `contradicts` and `supersedes` edges. Which fields count is a configuration key, read
the same way `extractLinks` already reads `link_fields`, so the core still enumerates no
vocabulary.

The field **annotates and never filters**. It does not re-rank, does not suppress, does not
remove a result. The invariant is testable and the test is the point: **result-set membership is
identical with and without it**. If anyone ever needs to relax that test, the feature has become
a ranking function that resolves contradictions, and it should be reverted rather than relaxed.

**Lint gains a consistency check over the supersession graph**, driven by the same configuration
key: a mutual `supersedes` pair, and a `supersedes` edge whose target does not carry the
reciprocal `superseded_by`. Both are pure graph properties over `links`. No page types, no
adapter knowledge, no inference.

## Alternatives rejected

**Promote supersession to the page schema, as `aliases` was.** ADR-0003 admits one exception to
vocabulary-is-configuration on the rule that a field belongs in the schema if every corpus has
it. Supersession appears to pass: RFCs, papers, ADRs, API versions and regulations all
accumulate superseded entries. Rejected because `aliases` has *one* meaning in every corpus,
while supersession's varies — obsoletes, revises, replaces, deprecates, amends — and a corpus
that means "revises" would inherit semantics it never asked for. What varies by corpus is
configuration. That is the whole of ADR-0003.

**Infer supersession from reading the sources.** The agent has read RFC 9110's header; it could
write the edge itself. Rejected: an inferred edge and a transcribed one are byte-identical in
frontmatter, so permitting inference makes the forbidden case indistinguishable from the
permitted one. Requiring a citation keeps the distinction visible, because only authority 4
cannot produce a line number.

**Rank or filter superseded pages out of results.** The obvious way to stop an agent citing an
obsolete RFC. Rejected outright: it is the constitution's third rule violated by the system
itself, and doing it at the interface is worse than doing it in a page, because it is invisible.

**Ship an external-registry adapter** that reads "Obsoleted by" from a publisher's index.
Rejected for now, not forever: the registry is a source that changes while the documents do not,
so it needs its own drift handling — an interesting recursion, and more machinery than the
problem currently justifies.

**Do nothing and call it a scope boundary.** A tool that never mentioned supersession would have
a clean boundary. This one ships the vocabulary in its default configuration and explains it in
the constitution, so the boundary is contradicted by the product's own presets. Scope boundaries
are honest only when declared.

## Consequences

- Drift remains byte-level, and now says so. Obsolescence is a different predicate with a
  different source of truth, and the documentation stops implying otherwise.
- A user who wants supersession tracked must declare it. The system will not guess, and that is
  the point rather than a limitation.
- `contested` is computed per query from an indexed table. It costs one lookup and no schema
  change.
- The membership-invariant test is the load-bearing artifact of this ADR. It is what keeps a
  signalling feature from becoming a resolving one.
- A knowledge base whose supersession edges are half-written now fails lint. Existing knowledge
  bases may go from green to red on first upgrade, which is the correct direction: they were
  never consistent, only unchecked.
