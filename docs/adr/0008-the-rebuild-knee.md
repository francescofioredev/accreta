# ADR-0008: The rebuild is the binding constraint, and the knee is at 15,000 pages

Status: proposed
Date: 2026-08-10

## Context

ADR-0004 rejected incremental indexing on the strength of one number — 43ms for 300 pages and
600 links — and closed by saying that "at a hundred thousand this decision would need
revisiting". Neither the number nor the threshold had been re-measured since. `bench/scale-bench.ts`
was written to settle both.

The 43ms is accurate. Matched at the ADR's own stated density, three runs, median: **29ms**, and
an independent seven-run measurement agreed at 31.9ms. An earlier reading of 82ms had compared a
corpus with roughly double the link count and concluded the ADR was "off by 2×"; it was not. That
correction is recorded because the proposal it produced would have amended a public ADR to make a
correct measurement look wrong.

The threshold is wrong, by an order of magnitude. Measured on darwin arm64:

| pages   | links   | build    | index   | per-page    |
| ------- | ------- | -------- | ------- | ----------- |
| 1,000   | 3,800   | 151ms    | 4.5MB   | 0.151ms     |
| 10,000  | 39,407  | 1,112ms  | 44.7MB  | 0.111ms     |
| 15,000  | 59,269  | 1,348ms  | 67.6MB  | **0.090ms** |
| 20,000  | 79,159  | 2,628ms  | 90.5MB  | 0.131ms     |
| 50,000  | 198,564 | 11,246ms | 223.8MB | 0.225ms     |
| 100,000 | 397,886 | 24,972ms | 449.1MB | 0.250ms     |

Per-page cost bottoms out at 15,000 pages and rises monotonically after. Between 15,000 and
20,000 the build grows 1.95× for 1.33× the pages.

The cause was isolated rather than inferred. Stage timings across two independent runs put
`readFileSync` at 42% of the rebuild at 10,000 files and 75% at 30,000, with per-file cost
stepping from ~15µs to ~42µs. Three plausible alternatives were eliminated by measurement:
SQLite insert throughput is linear and unaffected by a 200MB cache; retention and garbage
collection are not implicated, since streaming without retaining strings is equally slow;
directory layout is not implicated, since flat and 100-per-directory are within noise. What
remains is per-file syscall cost against filesystem metadata, saturating once the tree stops
fitting in cache.

That distinction decides everything downstream: it is a **constant-factor step, not unbounded
growth**. Past ~20,000 files the rebuild is linear again, at a higher rate.

Nothing else binds first. `revision()` on 100,000 files is 315ms and cleanly linear. `git diff
--name-only` at 100,000 files is below timer resolution. `lint` at 100,000 pages is 317ms. Index
size is exactly linear at 4.6KB per page. The rebuild is the constraint, and it is not close.

What makes it matter is where it sits. `update_verified_revision` writes markdown and instructs
the caller to reindex, so a full rebuild is paid **inside the agent's verification loop**. At
30,000 pages an agent verifying thirty pages spends about three minutes rebuilding an index whose
content changed by one frontmatter line each time. Nothing is wrong — no provenance is violated,
no drift is missed — which is why it will be experienced as "accreta is slow" rather than as a
threshold being crossed.

## Decision

**The answer to "when does the filesystem stop making sense" is 15,000–20,000 pages**, and what
binds is rebuild latency inside the verification loop. That number replaces the speculative "at a
hundred thousand" in ADR-0004's consequences.

**ADR-0004's decision stands, and its justification changes.** The durable argument for wholesale
rebuild is not that it is fast. It is that `links` and `broken_links` are **global**: renaming one
page changes the resolution status of every wikilink pointing at it, so an incremental update must
re-resolve the whole repository or leave lint's dangling-link check quietly reporting zero after a
directory rename. That is the failure this project is organised against, and it is a stronger
sentence than 43ms.

**Parallelise the read stage before considering incrementality.** The reads are syscall-bound
rather than CPU-bound, so they should parallelise, and doing so leaves the single transaction —
the property ADR-0004 exists to protect — completely intact. This is the rare optimisation that
does not trade against the invariant.

**Incrementality is third, not second**, and only if parallel reads prove insufficient. Note that
`pages.mtime` and `meta.max_mtime` are already written by the indexer and read by nothing, so the
hook exists; that is a reason for caution rather than encouragement.

## Alternatives rejected

**Correct the 43ms.** Rejected on measurement: matched-density runs are faster than the ADR
claims. Recorded here because the proposal was made and would have been wrong.

**Go incremental now, on the strength of the 25-second figure at 100,000 pages.** Rejected: a
per-file update that skips global link re-resolution produces an index where lint reports zero
dangling links after a rename — the corpus looks healthy and its graph is broken. Twenty-five
seconds of honest work beats a fast index that is quietly wrong. If someone builds an incremental
indexer that maintains global resolution correctly and beats wholesale by more than 5× at 10,000
pages while passing the full lint suite, this decision should fall.

**Cache tuning.** Rejected on measurement: a 200MB SQLite cache changed nothing, because SQLite
was never the bottleneck.

**Declare 100,000 pages out of scope and stop.** Tempting, and it is what ADR-0004 implies. But
the knee is at 15,000, and 15,000 pages is a corpus a serious user reaches — which is exactly why
the number belongs in an ADR rather than in a benchmark nobody reads.

## Consequences

- The scaling claim is now measured rather than asserted, and `bench/scale-bench.ts` is the
  artifact that keeps it honest.
- The synthetic corpora model a hub-and-tail link structure that **no real accreta corpus has been
  large enough to validate**. The only real knowledge base is ten pages with a maximum in-degree
  of three. Every hub-dependent figure is conditioned on that generator, and the benchmark says so.
- The knee is machine-dependent — it is a filesystem metadata-cache effect. The shape should
  transfer; the exact numbers will not.
- Batching reindexes across a verification pass, rather than one per write, is available and
  independent of everything above.
- The 100,000-page measurement is a single run. One sample cannot separate a complexity change
  from memory pressure at a 449MB index, and the finding says so.
