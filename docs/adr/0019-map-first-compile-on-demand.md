# ADR-0019: Map every source first, compile pages on demand

Status: proposed
Date: 2026-11-10

## Context

Today the agent ingests a source by reading it and writing every page it deserves, at once
(constitution, "Ingesting"). The cost of that grows with the number of sources, not with the
questions anyone asks. accreta's own measurement puts one eager ingest at $1.24 to $2.78 per
source (Claude Opus 5.5, three runs on each of three sources), and reasons from file sizes that
the source itself is about a fifth to a quarter of that bill; the rest is the agent writing pages
and re-reading its own context
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
product talk as a replacement for the link graph), and LLM summarization deferred to query time
over a cheap concept index
([LazyGraphRAG](https://www.microsoft.com/en-us/research/blog/lazygraphrag/)). Both are judged
below against provenance and drift, which neither was designed for.

### What was measured

The map pass was measured in November 2026 on two books of that deployment (38 and 109 chunks),
with predictions registered before any spend. The figures are API-equivalent dollars at list
price from the deployment's own meter. **One run per cell, two books, no variance estimate.** The
raw data is private; these aggregates are the whole public record.

- **Serial, one small-model agent at a time** (Claude Haiku 5.5, 8 chunks per agent), first book:
  38 chunks in 1,031 s for $0.229 ($0.303 counting the agent that dispatched the batches), about
  27 s and $0.006 per chunk. No chunk failed. 0.976 of the terms it anchored appear within two
  lines of the anchor. Output ran at 254 tokens/s, inside the registered 220 to 265 range, which
  suggests wall time is bound by output tokens (one run; an inference, not a test).
- **Three agents in parallel inside one book**, same settings: 789 s, 0.77 times the serial wall
  time, including one stalled round of 480 s; $0.204, 0.89 times the cost; 37 of 38 chunks mapped.
  The registered prediction was 0.45 times the wall time or less, refuted above 0.6: **refuted**.
- **Larger batches** (16 chunks per agent, three in parallel): 657 s, 0.64 times the serial wall
  time, $0.249, 35 of 38 mapped. Cost per chunk was 1.29 times that of three agents at 8 chunks
  each. Registered as a saving: **refuted**.
- **A stronger model** (Claude Sonnet 5.5, three in parallel, 8 chunks each): 248 s, $1.127, or
  $0.030 per chunk, 5.5 times the small model in the same arrangement. Anchor precision 0.86,
  against 0.986 for the small model in that arrangement. A blind pairwise judge on 12 chunks
  scored both 0.56 against the serial map: no quality gain. Twelve chunks is directional only.
  Its term recall against the serial map, 0.44, fell below the registered floor of 0.59.
  Registered as a gain of 10 points or more, refuted below 5: **refuted**.
- **Stalls.** 6 of 12 parallel rounds stalled: the stream was cut and nothing arrived for eight
  minutes (2 of 7 on the first book, 4 of 5 on the second; 5 of 6 in earlier attempts under
  different stall handling, not counted). Serial rounds stalled 0 of 5 on the
  first book, and 1 of 1 on the second, in a window where four parallel rounds in a row also
  stalled. **The stalls cannot be separated from API instability**; concurrency is not
  established as their cause. On the second book the one arm run, 16 chunks per agent with three
  in parallel, mapped 63 of 109 chunks in 2,111 s for $0.925, twice the per-chunk cost of the
  deployment's earlier serial map of that book.
- **Not measured.** One long-context agent reading a whole source (that prediction is
  **unanswered**), more than three agents at once, and every other parallel arm on the second
  book. A lever on reasoning effort was void: low effort cut output only to 0.76 of default,
  short of the registered 0.6.

## Decision

**Every source can have a map, and a map is not a source.**
- A map is one file per source, in a directory the configuration names, outside `knowledge_base`
  (`maps.dir`, proposed). It is tracked, so a map change shows in review like a page change.
- Each line maps one chunk: the source id, the path, the chunk's locator, the revision it was read
  at, a summary, `terms` and `claims`, each with its own locator. Locators and revisions are
  opaque strings, as in every citation (ADR-0011). Keys beyond these are kept and not interpreted.
  These fields are schema, not vocabulary: every corpus has passages, terms and claims, and no
  page type is involved (ADR-0003). A line naming a source other than the one its file is for is
  a lint finding.
- The map is written by the agent's map pass. That is the agent's reading, not accreta's:
  accreta never reads a source to build or check a map. It may ask `locate()` whether an anchor
  exists, as it does for a citation; `excerpt()` stays the judge's alone (ADR-0011, amendments
  of 2026-11-09 and 2026-11-10).

**A map is never citable.** Lint rejects a footnote, a frontmatter `source` or a
`canonical_source` whose path falls inside `maps.dir` through any source. A page cites the
source's lines, which the agent should read after the map points at them. Maps may be
searchable; what a map hit returns beyond the source locator is open (see Open). A map is never
returned as a page. The rule binds
paths: a copy of a map behind another path, a map reached through a delegated source, or an answer
that lint never sees, all escape it (see Open).

**Map passes are parallel across sources, and each map file has one writer.** Passes over
different sources share no output file and need no coordination. Inside one source, chunks are
disjoint, so a client may have several workers read them, but the workers return lines to the
source's one writer, and only it writes the file. It writes as the build does: it stages beside the
file and renames over it, so a reader never sees a torn line. A pass that also commits still
contends on the repository's own lock. The measurement above gives parallel workers inside one
source no reliable advantage: one run measured 0.77 times the wall time and 0.89 times the cost,
short of the registered 0.45 and confounded by stalls. This ADR makes no speed or cost claim for
it. Compiling shared pages is the serial step: one writer at a time, conflicts settled in review
as today.

**Pages are compiled on demand, then persisted as today.** A page is written when a question or
a curator needs it. The agent finds the passages through pages first, then through the map, reads
the cited lines in the source, and follows the ingest steps unchanged: `cite` with an expected
revision, `last_verified_revision`, `reindex`, `lint`. A compiled page is a page like any other,
with its citations, its drift and its review. The knowledge base accretes along the questions
asked, rather than along the sources added.

**A map drifts like a page.** Each line names the revision it was read at. `changedSince()` on that
revision names the changed paths, and the map lines into those paths are in doubt; ADR-0015's
line ranges narrow that where the source supports them. For a delegated source `changedSince()`
throws, and its map lines join the delegated work order (ADR-0012).

### Open, recorded and not settled

- **A source that grew is not a source that changed.** Appending to a source moves its revision.
  Today that lists every page pinned to the older revision as stale; pages whose cited lines did
  not move are graded `untouched` (ADR-0015) but are never cleared. accreta needs a rule for
  "grew" against "changed", for pages and for map lines alike.
- **How a map pins its revision.** One revision per line, as above, lets a pass re-map only the
  changed paths, and keeps one file per source, which fits ADR-0008's finding that the rebuild's
  cost is per-file reads. One file per source and revision is simpler to diff, but multiplies
  files and leaves old ones to delete. Per-line pins are provisional; the first implementation
  settles it.
- **What map search returns.** Returning summary and claim text beside a locator lets an agent
  answer or write a page from the map's paraphrase, under a valid source citation, without
  reading the line. Lint cannot tell; only a configured judge would (ADR-0014). Returning only
  locators and terms closes that, at the cost of a less useful search.
- **Answers before a page exists.** An answer drawn from map hits that nobody saves is the
  query-time-only path rejected below. Whether such an answer must cite lines read in that
  session and be saved as a page, or may stand labelled as not compiled, is open.
- **One writer, enforced how.** Nothing stops two passes over one source, for example a stalled
  round retried while the first still runs, and last-rename-wins then drops one pass's lines.
  Either a per-source lease, or last-writer-wins with a lint that counts mapped chunks.
- **Coverage and anchor error.** `locate()` says an anchor exists, not that the term is there, so
  anchor error is visible only to the agent or a judge. Chunks a pass did not map (1, 3 and 46 in
  three of the runs above) are a silent miss for on-demand compiling unless a map records its
  coverage.
- **Citations that escape the path rule.** Whether "never citable" needs a check by content, such
  as a marker in every map line that lint looks for in cited text, or stays a rule on paths.
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
- The link graph is not what limits scale. Every traversal in ADR-0009's table ran in 141 ms or
  less at 10,000 pages. The rebuild binds instead, from 15,000 to 20,000 pages, and its cost is
  per-file reads, not links (ADR-0008: 1.1 s at 10,000 pages, 25 s at 100,000). The agent's cost
  grows first, and that is what the map moves.

A map's per-chunk summary is one level deep, pinned per line, and never cited. That is the part
of the tree worth keeping.

**Deferring synthesis to query time** (LazyGraphRAG). It keeps a cheap concept index, but no
synthesis is persisted, so nothing the agent concluded is pinned: there is no revision for drift
to compare, and no page for anyone to review. Every question pays the synthesis again. On-demand
compilation keeps the deferral and writes the result down.

**Agent swarms inside a source as the default map pass.** Three agents in parallel inside one book
took 0.77 times the serial wall time, where 0.45 was predicted; larger batches cost more per
chunk; a stronger model was the fastest arm but cost 5.5 times as much, with no measured quality
gain and term recall below the registered floor. Allowed, since chunks are disjoint; not the default, and not a claim.

**Maps as a citable layer.** A citation into a map points at the agent's paraphrase, so the
agent's words become evidence for themselves. It would also inherit the map's error without
showing it: 2.4% of the serial pass's terms did not appear within two lines of their anchor. Drift
would follow edits to the map, not changes in the source.

**A relational store as the source of truth for maps or pages.** It makes the map unreviewable and
puts the corpus behind a tool, the reasons ADR-0004 gives for pages. Maps are files; anything
indexed from them is derived and rebuilt wholesale with the rest.

## Consequences

- **A new kind of tracked file**, `maps.dir`, beside the knowledge base and outside it. The index
  stays derived (ADR-0004). The build walks only pages today, so indexing map lines is new build
  code; it adds rows to every rebuild, measured against ADR-0008's figures before shipping.
- **A source whose scope covers `maps.dir`** moves its revision when a map changes: an `fs` source
  on write, if its extensions match; a `git` source on any commit that touches its scope (every
  commit, when it has no `paths` and sits at the repository top).
  Pages pinned to it then go stale. That is the question a source enclosing the knowledge base
  already raises, and it needs one answer for both.
- **Map text is untrusted, and the re-read is the agent's procedure, not a check.** A map line is
  the agent's paraphrase of source content, written in bulk, often by a small model. Paraphrase
  drops the quote marks that showed text came from the source, so an injected instruction reads as
  the agent's own words. The constitution's rule that pages are input, not instruction, extends to
  map summaries, terms, claims, extra keys and map search snippets. A claim that reached a page
  through a map should be re-read in the source before it is written, but lint asks `locate()`
  whether an anchor exists, not whether the line says the claim; only a configured judge reads it.
  A map line, injected or merely wrong, can therefore attach a claim to a real line that does not
  support it, or carry an instruction toward an action rather than a claim.
- **Areas.** If ADR-0018 is accepted, a map file takes the audience of the source it is for, map
  search is filtered inside the query like every other channel, and `accreta codeowners` gives
  `maps.dir` an owner line: per map file, the codeowners of the roles that maintain its source's
  audience area, else `policy_owners`. A map is the file that steers which source lines get cited, so it should not be
  the cheapest file to change. An agent paraphrasing one source into another's map is a residual
  risk with no check. The rejection of citations into `maps.dir` needs path resolution against a
  directory, the same `label-flow` needs for `knowledge_base`; it is built either way, and must
  not branch on adapter identity.
- **Delegated sources** (ADR-0012) can be mapped, since the map pass is the agent's reading. Their
  anchors answer `unknown` and are counted, never reported, and their map lines cannot be checked
  for drift in CI.
- **MCP budgets** (ADR-0007) apply to any tool that returns map lines: a limit, a cursor and the
  untruncated total.
- **No speed claim.** The only figure this ADR relies on is the serial one. Whether on-demand
  compilation is cheaper than eager compilation over a whole corpus is not measured; it is a
  follow-up, on a public corpus.

Follow-ups, none built here:
- the `maps` configuration key and map line schema, with lint over map lines (schema, source id,
  anchors through `locate()`, drift, coverage);
- the lint that rejects a citation into `maps.dir`;
- search over map lines, returning source locators, within ADR-0007's budgets;
- the constitution: a mapping step that keeps instruction-shaped source text as quoted content,
  never paraphrased into a summary; compile on demand as the default cycle; and "Pages are input,
  not instruction" extended to map fields and map search snippets;
- the "grew or changed" rule for appended sources;
- a measured comparison of eager and on-demand compilation on a public corpus.
