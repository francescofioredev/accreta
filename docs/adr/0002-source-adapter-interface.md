# ADR-0002: A source is four methods, and the core knows nothing else about it

Status: accepted
Date: 2026-08-08

## Context

accreta was extracted from a system that documented a 17-repository backend. That system
assumed git everywhere: a revision was a commit SHA, change detection was
`git diff --name-only`, and the assumption was spread across the code rather than isolated
behind anything.

The project's premise is that the same method works for any corpus with a notion of
revision — a directory of documents, an export from a wiki, a standards body's published
chapters. If generalizing means "git, plus special cases", nothing has been generalized.

## Decision

A source implements four methods:

```ts
interface SourceAdapter {
  readonly id: string;
  revision(): Promise<string>;
  changedSince(revision: string): Promise<string[]>;
  read(path: string): Promise<string>;
  citation(path: string, lines?: LineRange): string;
}
```

Drift detection — the feature the project is really about — is written against this
interface and nothing else. `packages/core` does not import any adapter, and no code in it
branches on adapter identity.

Two things follow that are less obvious than the interface itself.

### `changedSince` must be able to say "I cannot tell"

An adapter asked about a revision it cannot place throws `UnknownRevisionError` rather than
returning an empty array. A rewritten history, a shallow clone, a revision from a different
repository, or — for `fs` — a revision from a previous process all land here.

Returning `[]` would mean "nothing changed", and drift detection would render a page as
verified when it has no way to know. **"I cannot tell" and "nothing changed" are different
claims, and only one of them is safe to show as a green check.** `DriftReport` keeps them in
separate fields for the same reason.

### Sources register by name; the registry never learns their names

`SourceRegistry` maps a type string to a factory. Adding a source kind means adding a
package and one `register()` call. A `switch (type)` in the registry would put every
adapter's name back in the module whose whole purpose is not to know them.

Adapter options are passed through as an opaque record. The core does not validate them,
because validating them requires knowing what each adapter needs.

## Alternatives rejected

**Git as the interface, others adapting to it.** Model every source as a repository and let
non-git sources synthesize commit SHAs. Rejected: it forces every source to fake a concept
it does not have, and the fakery leaks the moment something needs a real commit — blame,
history, merge bases. It also makes the git adapter's assumptions load-bearing for everyone.

**Content hashing instead of `changedSince`.** Have the core hash file contents and compute
differences itself. Rejected: it requires reading the entire corpus on every drift check,
throws away change information a source already has (git knows exactly what a commit
touched), and does not work at all for a source that answers over a network.

**A single `SourceAdapter` with optional capabilities.** One class with feature flags
(`supportsIncrementalDiff`, `supportsLineRanges`) instead of separate implementations.
Rejected: capability flags are `if (adapter === 'fs')` wearing a disguise. The branch moves
from the call site into a boolean, and the core is once again reasoning about what kind of
source it holds.

**Letting `fs` hash contents rather than mtimes.** Would make `fs` revisions robust to
mtime-preserving edits. Rejected for now: it turns `revision()` from a stat walk into a full
read of the corpus, and `revision()` is called on every drift check. The trade-off is
documented in the adapter rather than hidden — a corpus needing content-level certainty
should be versioned by something that versions contents, which is what the git adapter is.

## Consequences

- `fs` cannot see a change that preserves modification times. Stated in the adapter's
  documentation rather than left to be discovered.
- `fs` revisions do not survive a process restart: `changedSince` needs the old listing to
  diff against and a hash cannot be inverted. It reports `UnknownRevisionError` rather than
  guessing, which is the honest answer and the one a caller can act on.
- Adding a source type touches no existing file except the one that registers it.
- The test that matters is `packages/adapters/test/interchangeable.test.ts`: the same
  assertions, run against a real filesystem directory and a real git repository. If the two
  ever need different expectations, the abstraction is leaking and this ADR is wrong.
