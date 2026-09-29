# ADR-0002: A source is four methods, and the core knows nothing else about it

Status: accepted, interface amended by [ADR-0011](0011-a-citation-points-at-a-locator.md)
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

A source implements four methods (`read` was later replaced by `locate`, and `citation` now
takes an opaque locator rather than a line range — see ADR-0011):

```ts
interface SourceAdapter {
  readonly id: string;
  revision(): Promise<string>;
  changedSince(revision: string): Promise<string[]>;
  read(path: string): Promise<string>;
  citation(path: string, lines?: LineRange): string;
  pinRevision(revision: string): void;
}
```

Drift detection — the feature the project is really about — is written against this
interface and nothing else. `packages/core` does not import any adapter, and no code in it
branches on adapter identity.

Two things follow that are less obvious than the interface itself.

### `changedSince` must be able to say "I cannot tell"

An adapter asked about a revision it cannot place throws `UnknownRevisionError` rather than
returning an empty array. A rewritten history, a shallow clone, a revision from a different
repository, or — for `fs` — a revision whose saved listing is gone all land here.

Returning `[]` would mean "nothing changed", and drift detection would render a page as
verified when it has no way to know. **"I cannot tell" and "nothing changed" are different
claims, and only one of them is safe to show as a green check.** `DriftReport` keeps them in
separate fields for the same reason.

### A citation names the revision it was checked against, so pinning is on the interface

*Amended 2026-08-10 — this method was added after the original decision. See below.*

`citation()` renders a revision, but only the caller knows which revision a claim was
verified against. `pinRevision` is how the caller says so, and it is the interface's one
mutator.

It was originally a `GitSource`-only method, on the reasoning that pinning was a git
concern. That was wrong in a way worth recording, because the cost was not the asymmetry
itself: **a property that is not on the interface cannot be asserted by the conformance
suite.** `fs` shipped a `citation()` that rendered `rev="unknown"` for every citation ever
produced — provenance that was present, well-formed and false — and passed its own
adapter tests, because the shared suite could only check the path and line tail. The
defect and the reason it went undetected were the same fact.

The unpinned fallback is shared (`UNPINNED_REVISION`) rather than per-adapter for the same
reason. `git` fell back to `"HEAD"`, which reads as a real revision and so states something
the source cannot support; `fs` fell back to `"unknown"`. An adapter that has not been told
what to cite against must say so, identically, or the reader cannot tell which kind of
source produced the claim.

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

**Fixing the `fs` citation without touching the interface.** Assign the revision inside
`fs`'s own `revision()` and leave `SourceAdapter` at four methods — a one-line change that
closes the visible bug. Rejected: it makes the citation name whatever the last drift check
happened to compute rather than what the claim was checked against, which is the guess this
interface exists to prevent. It also leaves the real defect in place, since the conformance
suite still could not express the property, and the next adapter would be free to
reintroduce it.

**Letting `fs` hash contents rather than mtimes.** Would make `fs` revisions robust to
mtime-preserving edits. Rejected for now: it turns `revision()` from a stat walk into a full
read of the corpus, and `revision()` is called on every drift check. The trade-off is
documented in the adapter rather than hidden — a corpus needing content-level certainty
should be versioned by something that versions contents, which is what the git adapter is.

## Consequences

- `fs` cannot see a change that preserves modification times. Stated in the adapter's
  documentation rather than left to be discovered.
- `changedSince` on `fs` needs the old listing to diff against, and a hash cannot be
  inverted. Without that listing it reports `UnknownRevisionError` rather than guessing,
  which is the honest answer and the one a caller can act on.
  *Amended 2026-09-29 (#125):* the listings used to live only in memory, so every CLI run
  was a new process and a changed `fs` source never read as stale, only as unplaceable. They
  are now saved in the state directory the registry passes, beside the index, as
  `fs-snapshots/<16-hex prefix of sha256(id)>/<revision>.json`, self-gitignored. Each is
  checked against its own hash when read. A missing, pruned or damaged listing is still
  `UnknownRevisionError`. Unlike the index they cannot be rebuilt: losing them costs
  re-verification, never correctness.

  **Pruning rule.** This is the one statement of it; other documents link here.
  - Every `revision()` starts a run. It moves `.last-run` to `.prev-run` and touches
    `.last-run`, so the directory remembers when the last two runs started.
  - A snapshot either of those runs wrote or read has an mtime at or after the earlier start,
    and is never evicted. Drift reads every cited revision, and a read refreshes the file even
    when a long-lived process answers it from memory. So what pages cite stays in that
    protected set, however long the corpus sits idle.
  - Two generations, not one, because a run that reads nothing (overlapping, or aborted after
    `revision()`) would otherwise leave every cited snapshot unprotected. Measured in review:
    10 of 10 were lost to one such run.
  - Every time the prune compares is set by accreta from one clock: markers, reads and
    writes alike. Linux stamps a write from a coarser clock, and in CI that dated a snapshot
    0.39 ms before the marker of the run that wrote it.
  - Anything else is evicted oldest first, and only while the source's snapshots exceed
    64 MiB. If the protected set alone exceeds it, it is kept, and `accreta doctor` says so.
  - A snapshot over 64 MiB is never written, because it could never be read back. That is
    about 1.4M files at the 35–59 bytes per file measured in review. Such a source reads
    "cannot place", and doctor says why.

  **The state directory.** Git stores symlinks, so a committed link could aim the writes and
  the prune anywhere.
  - The default `<root>/.accreta` is checked as written. One chosen through
    `ACCRETA_INDEX_PATH` is resolved first, because the operator chose it.
  - From there down, every step must be a real directory. The two that accreta creates,
    `fs-snapshots` and `<hash>`, must also be this user's and writable by nobody else.
    Otherwise persistence is off and doctor says why. Ownership is not checked on Windows,
    which has no `getuid`.
  - The state dir itself is held to less, so an index in `/tmp` or under umask 002 still
    keeps snapshots.
    - A group-writable state dir is accepted. That is trust in the group, which is what
      umask 002 already expresses.
    - A world-writable state dir must be sticky, or anyone could rename our directories and
      race the checks. Measured in review at mode 0777: 23 snapshots and 12 staging files
      landed in a victim directory in 20 s.
    - A sticky state dir must be owned by this user or root, as `/tmp` is.
  - That is enough. Inside such a parent, only we, the parent's owner, or root can rename our
    0700 directories. Whatever sits at those names is checked again on every open, so a
    replacement that is not ours, or a symlink, turns persistence off rather than being
    written to.
  - Directories are created 0700 and files 0600, so a shared machine does not expose the
    corpus's file names.
  - Prune removes only regular files with its own names. Snapshots are opened without
    following links or blocking.
- A revision must be placeable by a new instance of the adapter. If it cannot be, throw
  `UnknownRevisionError`, and the conformance suite will fail. Every CLI run is a new
  process, so an adapter that only remembers in memory has no drift from the CLI.
- Adding a source type touches no existing file except the one that registers it.
- An adapter must be pinned before its citations mean anything. Unpinned it renders
  `UNPINNED_REVISION`, which is checkable and honest, rather than a plausible-looking
  revision that is neither.
- The test that matters is `packages/adapters/test/interchangeable.test.ts`: the same
  assertions, run against a real filesystem directory and a real git repository. If the two
  ever need different expectations, the abstraction is leaking and this ADR is wrong.
