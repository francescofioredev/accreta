# ADR-0010: A long-lived reader revalidates the index by inode

Status: accepted
Date: 2026-08-17

## Context

A rebuild stages the new index beside the live one and moves it into place with `rename(2)`.
That is atomic, so no reader ever opens a half-rebuilt database. It says nothing about a
connection that outlives the swap, and there the two platforms disagree:

- **macOS** revalidates the file and fails the connection with `SQLITE_IOERR`. Measured: every
  read throws `disk I/O error`, permanently and per-connection — three swaps and a 200ms
  settle did not recover it.
- **Linux** keeps the unlinked inode alive behind the open descriptor, so the stale handle
  goes on serving pre-rebuild rows and every call *succeeds*.

The MCP server opened the index once and never reopened it. So an agent that verified a page,
reindexed, and asked for it again was either told `disk I/O error` for the rest of the session,
or — on the platform a hosted deployment actually runs on — handed the page as it was before
its own write, with no indication anything was wrong. The project got the loud failure where it
is developed and the quiet one where it is deployed.

This was not undiscovered. `build.ts` already documented the split and concluded that "a
long-lived reader must therefore reopen after a rebuild". Nothing did.

`update_verified_revision` writes markdown and asks the caller to reindex, so a rebuild during
a session is the documented path rather than an edge case.

## Decision

**The context stats the index and compares `dev:ino` before each use, reopening when it
changes.** `rename(2)` always gives the new file a different inode, so this is the same check on
both platforms.

**Identity is checked out of band** — by asking the filesystem, not the connection. A connection
that is already failing cannot be asked anything, and a stale one on Linux would answer with the
old value.

**The new connection is opened before the old one is closed**, so a failed reopen leaves a
working context instead of a permanently dead one.

**A missing file is not treated as a swap.** A rebuild is never observable as an absence, so
`statSync` throwing means the index is genuinely gone; the existing connection is returned and
its own error surfaces.

The context object's identity never changes — the server registers its tools against one object
and never asks for another — so the reopen happens behind a `db` accessor.

## Alternatives rejected

**A build id in `meta`, compared per call.** The obvious platform-independent answer, and blind
in both cases it exists for: on macOS the connection is already throwing, so it cannot be
queried at all; on Linux a stale connection returns the *old* id off the unlinked inode. It
would cost a write per rebuild and a query per call to detect nothing `stat` misses.

**Reopening on every call.** A `stat` is cheap; opening a database is not, and every read tool
would pay it.

**Catching `SQLITE_IOERR` and retrying.** Fixes only macOS. Linux's stale reader never errors —
it returns wrong answers — so the worse half of the bug would survive untouched.

**Holding no connection and opening per call.** Correct, and it discards the reason the server
holds one at all.

## Consequences

Every read tool pays one `statSync` — a cheap syscall against a hot inode.

`check_drift` pins the connection once per call: it loops over adapters across `await`
boundaries, and re-reading the accessor per adapter could draw one report from two indexes.

The behaviour is now the same on both platforms, so the tests can assert it. They previously
asserted only that a *reopened* connection sees the new index, deliberately leaving the fate of
a held handle unpinned to avoid encoding one platform's semantics as a promise.

This unblocks the hosted deployment in #21, where a long-lived server is unavoidable.
