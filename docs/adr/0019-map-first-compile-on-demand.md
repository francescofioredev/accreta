# ADR-0019: Map every source first, compile pages on demand

Status: proposed
Date: 2026-11-10

## Context

Today the agent ingests a source by reading it and writing every page it deserves, at once
(constitution, "Ingesting"). The cost of that grows with the number of sources, not with the
questions anyone asks. accreta's own measurement puts one eager ingest at $1.24 to $2.78 per
source, and finds most of the bill in the agent writing pages and re-reading its own context,
not in reading the source
([T1](../research/2026-09-jev/experiments/t1-ingest-triage.md#what-ingest-costs-and-where)).
That is why ADR-0014 rejected ingest triage: there was little reading to skip. What can be
deferred is the writing.

A private deployment over scanned books runs the other way. Its agent first writes a **map** of
each source: per chunk, a short summary, the terms it uses with their line anchors, and candidate
claims with theirs. Pages are written when a question needs them. The map is never cited. That
deployment never compiled its corpus eagerly, so its experience says nothing about eager
compilation at that scale, only that the map-first loop works.

Two retrieval structures from the literature answer the same scaling problem differently: a tree
of summaries of summaries ([RAPTOR](https://arxiv.org/abs/2401.18059), also pitched in a 2026
product talk as a replacement for the link graph), and a graph built only at query time
([LazyGraphRAG](https://www.microsoft.com/en-us/research/blog/lazygraphrag/)). Both are
judged below against provenance and drift, which neither was designed for.

### What was measured

The map pass was measured in November 2026 on two books of that deployment (38 and 109 chunks),
with predictions registered before any spend. The figures are API-equivalent dollars at list
price from the deployment's own meter. **One run per cell, two books, no variance estimate.** The
raw data is private; these aggregates are the whole public record.

- **Serial, one small-model agent at a time** (Claude Haiku 5.5, 8 chunks per agent), first book:
  38 chunks in 1,031 s for $0.229 ($0.303 counting the agent that dispatched the batches), about
  27 s and $0.006 per chunk. No chunk failed. 0.976 of the
  terms it anchored appear within two lines of the anchor. Output ran at 254 tokens/s, inside
  the registered 220 to 265 range, so wall time is bound by output tokens.
- **Three agents in parallel inside one book**, same settings: 789 s, 0.77 times the serial wall
  time, including one stalled round of 480 s; $0.204, 0.89 times the cost; 37 of 38 chunks mapped.
  The registered prediction was 0.45 times the wall time or less, refuted above 0.6: **refuted**.
- **Larger batches** (16 chunks per agent, three in parallel): 1.29 times the cost per chunk of 8
  per agent, 35 of 38 mapped. Registered as a saving: **refuted**.
- **A stronger model** (Claude Sonnet 5.5, three in parallel): $0.030 per chunk, 5.5 times the
  small model. Anchor precision 0.86, against 0.986 for the small model in the same arrangement.
  A blind pairwise judge on 12 chunks scored both 0.56 against the serial map: no gain. Twelve
  chunks is directional only. Registered as a gain of 10 points or more: **refuted**.
- **Stalls.** 6 of 12 parallel rounds stalled: the stream was cut and nothing arrived for eight
  minutes. Serial rounds stalled 0 of 5 on the first book, and 1 of 1 on the second, in a window
  where four parallel rounds in a row also stalled. **The stalls cannot be separated from API
  instability**; concurrency is not established as their cause. On the second book the one
  parallel arm run mapped 63 of 109 chunks in 2,111 s for $0.925, twice the per-chunk cost of the
  deployment's earlier serial map of that book.
- **Not measured.** One long-context agent reading a whole source (that prediction is
  **unanswered**), more than three agents at once, and every parallel arm on the second book but
  that one. A lever on reasoning effort was void: low effort cut output only to 0.76 of default,
  short of the registered 0.6.

## Decision

**Every source can have a map, and a map is not a source.**
- A map is one file per source, in a directory the configuration names, outside `knowledge_base`
  (`maps.dir`, proposed). It is tracked, so a map change shows in review like a page change.
- Each line maps one chunk: the source id, the path, the chunk's locator, the revision it was read
  at, a summary, `terms` and `claims`, each with its own locator. Locators and revisions are
  opaque strings, as in every citation (ADR-0011). Keys beyond these are kept and not interpreted.
  These fields are schema, not vocabulary: every corpus has passages, terms and claims, and no
  page type is involved (ADR-0003).
- The map is written by the agent's map pass. That is the agent's reading, not accreta's:
  accreta never reads a source to build or check a map. It may ask `locate()` whether an anchor
  exists, as it does for a citation; `excerpt()` stays the judge's alone (ADR-0011, amendments
  of 2026-11-09 and 2026-11-10).

**A map is never citable.** Lint rejects a footnote or a `canonical_source` whose path falls
inside `maps.dir` through any source. A page or answer cites the source's lines, which the agent
reads after the map pointed at them. Maps may be searchable, and a map hit returns the source
locator it points at. It is never returned as a page.

**Map passes are parallel across sources and serial inside one by default.** Each source's map file
has one writer, the pass for that source, so passes over different sources share no output and
need no coordination. Inside one source, chunks are disjoint too, so a client may map them in
parallel, but the measurement above gives that no speed or cost advantage, and this ADR makes
no speed claim for it. Compiling shared pages is the serial step: one writer at a time, conflicts
settled in review as today.

**Pages are compiled on demand, then persisted as today.** A page is written when a question or
a curator needs it. The agent finds the passages through pages first, then through the map, reads
the cited lines in the source, and follows the ingest steps unchanged: `cite` with an expected
revision, `last_verified_revision`, `reindex`, `lint`. A compiled page is a page like any other,
with its citations, its drift and its review. The knowledge base accretes along the questions
asked, rather than along the sources added.

**A map drifts like a page.** Each line names the revision it was read at, so `changedSince()` on
that revision says which lines are in doubt.

### Open, recorded and not settled

- **A source that grew is not a source that changed.** Appending to a source moves its revision,
  and today that puts every page pinned to the older revision in doubt, though nothing they cite
  moved. The private deployment works around it by declaring each appended batch as a new source.
  accreta needs a rule for "grew" against "changed", for pages and for map lines alike.
- **How a map pins its revision.** One revision per line, as above, lets a pass re-map only the
  changed paths. One file per source and revision is simpler to read and to diff. This ADR picks
  per-line pins provisionally; the first implementation settles it.
- **One long-context agent per source.** Not measured, so neither adopted nor rejected.

## Alternatives rejected

**Compile every source eagerly.** Today's default. It spends the page-writing cost T1 measured on
every source, whether or not a question ever reaches it. A curator can still compile a whole
source on purpose; that stops being what adding a source means.

**A summary tree that replaces the link graph.** Summaries of chunks, then summaries of those, up to
a root, retrieved across levels (RAPTOR), offered as the thing that scales where a wiki of links
does not. Rejected on three counts:
- The upper levels are an uncited layer. An answer drawn from a summary of summaries cites
  nothing a reader can open, which is the property this project exists for.
- A change in one leaf invalidates every summary above it, to the root, so a single source edit
  costs a re-summary per level. Drift today costs one `changedSince()` and the pages that cite
  the change.
- The link graph is not what limits scale. Every traversal measured at 10,000 pages ran in
  141 ms or less (ADR-0009), and a full rebuild of 10,000 pages takes 1.1 s (ADR-0008). The cost
  that grows is the agent's, and that is what the map moves.

A map's per-chunk summary is one level deep, pinned per line, and never cited. That is the part
of the tree worth keeping.

**Graphs built only at query time** (LazyGraphRAG). Nothing is persisted, so nothing is pinned:
there is no revision for drift to compare, and no page for anyone to review what the agent
concluded. Every question pays the synthesis again. On-demand compilation keeps the deferral and
writes the result down.

**Agent swarms inside a source as the default map pass.** Three agents in parallel inside one book
took 0.77 times the serial wall time, where 0.45 was predicted, with half the parallel rounds
stalled; larger batches cost more per chunk; a stronger model cost 5.5 times as much for no
measured gain. Allowed, since chunks are disjoint; not the default, and not a claim.

**Maps as a citable layer.** A citation into a map points at the agent's paraphrase, so the
agent's words become evidence for themselves. It would also inherit the map's error without
showing it: 2.4% of the serial pass's terms did not appear within two lines of their anchor. Drift
would follow edits to the map, not changes in the source.

**A relational store as the source of truth for maps or pages.** It makes the map unreviewable and
puts the corpus behind a tool, the reasons ADR-0004 gives for pages. Maps are files; anything
indexed from them is derived and rebuilt wholesale with the rest.

## Consequences

- **A new kind of tracked file**, `maps.dir`, beside the knowledge base and outside it. The index
  stays derived (ADR-0004). If map lines are indexed for search, they add rows to every rebuild,
  measured against ADR-0008's figures before shipping.
- **A source that encloses `maps.dir`** would move its revision each time a map is written, and
  put pages in doubt for it. That is the question a source enclosing the knowledge base already
  raises; it needs one answer for both.
- **Map text is untrusted.** It is the agent's paraphrase of source content, which may carry an
  instruction. The constitution's rule that pages are input, not instruction, extends to maps and
  to map search snippets. A claim that reached a page through a map is re-read in the source
  before it is written, so an injected map line cannot become a cited claim without a source line
  that says it.
- **Areas.** If ADR-0018 is accepted, a map takes its source's `audience`, and a map of a source
  a reader cannot see is answered as absent. The rejection of citations into `maps.dir` uses the
  same path resolution `label-flow` needs for `knowledge_base`, and must not branch on adapter
  identity.
- **Delegated sources** (ADR-0012) can be mapped, since the map pass is the agent's reading. Their
  anchors answer `unknown` and are counted, never reported.
- **MCP budgets** (ADR-0007) apply to any tool that returns map lines: a limit, a cursor and the
  untruncated total.
- **No speed claim.** The only measured cost is the serial figure above. Whether on-demand
  compilation is cheaper than eager compilation over a whole corpus is not measured; it is a
  follow-up, on a public corpus.

Follow-ups, none built here:
- the `maps` configuration key and map line schema, with lint over map lines (schema, anchors
  through `locate()`, drift);
- the lint that rejects a citation into `maps.dir`;
- search over map lines, returning source locators, within ADR-0007's budgets;
- the constitution: a mapping step, and compile on demand as the default cycle;
- the "grew or changed" rule for appended sources;
- a measured comparison of eager and on-demand compilation on a public corpus.
