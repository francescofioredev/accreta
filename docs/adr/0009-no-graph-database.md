# ADR-0009: No graph database; SQLite serves every traversal a knowledge base needs

Status: proposed
Date: 2026-08-10

## Context

accreta stores a link graph. "Model it in a graph database" is the answer everyone reaches for on
hearing that, and it is usually wrong for one-hop queries an indexed edge table already serves.
The question deserved measurement rather than instinct, in both directions.

Every traversal a knowledge base plausibly wants was written as a recursive CTE and run against a
10,000-page corpus with 40,406 links and a genuine hub (in-degree 1,727 — the adversarial cases
were included, not avoided):

| Traversal                               | How                           | Measured |
| --------------------------------------- | ----------------------------- | -------- |
| one-hop "what links here"               | already shipped, index-served | 3ms      |
| authority ranking over citations        | one `GROUP BY`, no recursion  | 1.8ms    |
| transitive closure from a leaf          | recursive CTE                 | 0.02ms   |
| transitive closure inbound from the hub | recursive CTE                 | 33ms     |
| shortest path between two concepts      | recursive CTE                 | 1.4ms    |
| cycle detection in supersession chains  | recursive CTE                 | 141ms    |
| connected components                    | recursive CTE                 | 54ms     |

What makes this work is already in the schema: `links` carries indexes in **both** directions,
`idx_links_src` and `idx_links_dst`. A hand-written in-process traversal was 15ms against the
CTE's 54ms, so SQLite is within a small constant of the best achievable.

One result is worth more than the rest, because it is the trap that would have produced the
opposite conclusion. A recursive CTE that carries a `depth` column silently defeats SQLite's cycle
protection: `UNION` deduplicates whole tuples, so `(node, 3)` and `(node, 5)` are distinct rows and
a node re-enters the queue once per depth at which it is reachable. On a hub graph that is
combinatorial. Measured twice, independently: the depth-carrying form returned 66,997 rows for
9,996 distinct nodes and ran 7× slower in one measurement and 148× slower in another
(query-shape-dependent — neither multiplier should be quoted as general).

Bounding depth is the _natural_ instinct for anyone writing their first traversal. Someone who
writes it that way, measures eight seconds and a nonsensical node count at 10,000 pages, and
concludes "SQLite cannot do graph traversal" would have justified a second datastore with a
benchmark measuring a defect in their own query.

## Decision

**No graph database.** SQLite's recursive CTEs serve every traversal identified, at latencies that
are not close to a constraint.

**The constraint that decides it is not performance.** accreta runs offline with `bun:sqlite` as
its only storage dependency. A server-based store breaks that outright. An embedded one does not —
but it breaks something ADR-0004 exists to protect: it would be a **second derived artifact to
keep consistent with the markdown**, reintroducing exactly the staleness class that ADR rejected
incremental indexing to avoid. A store that can disagree with the files while nothing notices is
the worst trade available to a system whose purpose is not being quietly wrong.

**Any traversal that ships must use `UNION` over the node column alone.** If depth must be
reported, compute it outside the recursion. And any traversal benchmark committed to `bench/` must
**assert the result size alongside the timing** — the nonsensical node count was visible before the
timing was, and an assertion on size would have caught it instantly.

## Alternatives rejected

**An embedded graph database** (Kùzu, or similar). The only candidate that preserves the offline,
zero-API-key guarantee. Rejected for the second-source-of-truth reason above, not for performance.
If a needed traversal ever exceeds roughly one second at 10,000 pages _in its best formulation_,
this is the alternative to revisit — variable-length path patterns with predicates on intermediate
nodes is the plausible candidate, and no accreta feature requests it today.

**A server-based graph database** (Neo4j). Rejected outright: it ends offline operation, which is
not a trade this project is willing to make for a traversal SQLite serves in milliseconds.

**Materialise a closure table** so multi-hop traversal becomes a lookup. Rejected as premature —
recursive CTEs are fast enough that a denormalised table would add invalidation work for no
measured gain. Reopen if a multi-hop query ever lands in a hot path.

**Say nothing and leave the question open.** Rejected because it would be relitigated on instinct
every time someone new reads `schema.sql` and sees an edge list. ADR-0001 is the precedent: this
project writes ADRs for things it decides _not_ to build, specifically so the decision is answered
with numbers.

## Consequences

- The measured table above is the artifact that makes this decision falsifiable. The falsification
  is named and cheap to run.
- The hub in these measurements has in-degree 1,727 because the generator was built to produce
  one. **The only real accreta corpus is ten pages with a maximum in-degree of three.** Every
  hub-dependent figure is an upper bound with no real instance behind it, and if agent-compiled
  knowledge bases turn out to have flat degree distributions, these numbers are pessimistic rather
  than optimistic.
- The `depth`-column trap should be recorded as a comment beside the `links` indexes in
  `schema.sql`, where the first person to write a traversal will read it.
- None of these traversals is currently exposed by any tool. This ADR establishes that they _can_
  be, not that they should be.
