# ADR-0007: A tool response is a context-window budget, and four of ours have none

Status: accepted, with a provisional default limit: see
[The default is provisional](#the-default-is-provisional).
Date: 2026-08-10

## Context

The consumer of the MCP server is a language model with a finite context window. Every token a
tool returns is a token unavailable for reasoning, so an unbounded response is not more helpful
than a bounded one — it is less helpful, and it fails in a way that looks like the agent's fault.

Only `search_pages` bounds its output, at 20 results by default and 50 at most. `get_page` is
bounded by the page the caller asked for, which is correct. The other four are not bounded at
all, and `lint_knowledge_base` takes an empty input schema, so an agent cannot ask for less even
when it knows it should.

`bench/mcp-budget.ts` was written for this decision. Measured on darwin arm64:

| pages | search | get_page | find_consumers | lint    |
| ----- | ------ | -------- | -------------- | ------- |
| 10    | 3.2KB  | 29.8KB   | 1.5KB          | 1.7KB   |
| 100   | 6.4KB  | 29.8KB   | 15.6KB         | 16.0KB  |
| 1,000 | 6.5KB  | 29.8KB   | 157.1KB        | 159.2KB |

At 1,000 pages `lint_knowledge_base` is roughly a fifth of a 200,000-token window. The break-even
is about 4,900 findings: past that the answer alone no longer fits, before the system prompt,
before the pages needing repair, before any plan. **The agent that called lint in order to fix
the knowledge base is the one that cannot read the reply**, and the failure surfaces as the agent
appearing to give up rather than as an error naming its cause.

`check_drift` is worse, and worse in kind. `detectDrift` copies the whole `changedPaths` array
into every stale page, so a report costs pages × changed-paths:

| pages | changed | response | share of a 200k window |
| ----- | ------- | -------- | ---------------------- |
| 100   | 10      | 66.5KB   | 8.5%                   |
| 1,000 | 10      | 663KB    | 84.9%                  |
| 1,000 | 100     | 4.9MB    | 647%                   |

The worst case is not exotic. It is what a git ingest produces by construction: every page
verified in one run records the same HEAD, so P is the whole knowledge base. The only real corpus
in the repository confirms it — all ten pages of `examples/climate` share one revision. A
thousand-page knowledge base and a merge touching a hundred files returns several times a full
context window, at the moment drift detection is the thing the user needed.

Two figures in that benchmark must not be over-read, and are recorded here so they are not.
`get_page`'s flat 29.8KB is entirely a synthetic 400-sentence body; real pages run 756 to 1,783
bytes, and `get_page` is already correctly bounded. `find_consumers` at 157KB is a perfect star
graph, an upper bound rather than a typical case. The token figures use bytes/4, which
understates JSON, so every percentage is a floor.

## Decision

**Normalise the drift report before bounding anything.** Emit `changedPaths` once per stale
revision rather than once per page: `stale: [{ revision, changedPaths, pages: [...] }]`. The data
is already grouped that way internally and then flattened. This removes the P multiplier entirely
and **loses no information** — no report becomes less complete, so there is nothing to trade
against.

**Give the unbounded tools the contract `search_pages` already has**: a `limit`, an offset or
cursor, and for lint a filter over the five finding kinds. Truncation must be visible, so the
response carries the **untruncated total** alongside the bounded page. Reporting a truncated
count as if it were the total would be the same class of error as reporting `unresolvable` as
"current" — a claim the system cannot support — and this project already refuses that one.

**A response budget is a first-class concern**, measured by `bench/mcp-budget.ts`, and a tool
added without one is incomplete.

### The default is provisional

Every list tool takes **`limit`, default 50**, an **opaque `cursor`**, and returns the
**untruncated `total`**.

- 50 is already `search_pages`' maximum, so every list tool shares one ceiling.
- Its cost is measured: 50 lint findings serialise to 8.5KB, about 2.1k tokens or 1.1% of a 200k
  window. The figure is the same at 100 and at 1,000 pages, which is the point of a limit.
- The cursor is opaque so the paging scheme can change without changing callers.

The number is provisional because the risk it carries is unmeasured: an agent that pays a turn per
page may fix _fewer_ findings and stop early believing it is done. The experiment below measures
that. It tunes the number. It is not a condition for shipping it.

## Alternatives rejected

**Leave them unbounded, because truncating a report is quiet incompleteness.** The strongest
objection, and it defeats truncation but not normalisation: the drift fix removes the multiplier
without dropping a single path. For the rest, an unbounded response that overruns the window is
not more complete — it is _entirely_ lost, which is the worse incompleteness.

**Bound them by summarising server-side** — return counts and let the agent drill in. Rejected:
it is the server deciding what matters, and that judgement belongs to the caller. A limit with an
honest total leaves the decision where it was.

**Rely on MCP's cursor pagination.** The protocol defines cursors for its own list operations
(`tools/list`, `resources/list`), not for arbitrary tool results. It supplies the convention, not
the mechanism; each tool must carry its own cursor in its input schema.

**Wait for the experiment before picking a default.** This ADR's first draft did that. Rejected:
nobody ran the experiment, and in the meantime every list tool stayed unbounded, which is the
worse failure. The experiment still stands, as the way to tune the number: findings fixed per
session, bounded versus unbounded, on the same seeded corpus.

## Consequences

- `check_drift`'s response shape changes. The CLI and any consumer must read the grouped form.
- Callers of the bounded tools must handle truncation; the total makes that possible without
  guessing.
- The default of 50 has a measured cost, not a measured optimum. When the experiment runs, its
  result replaces the number here.
- `bench/mcp-budget.ts` should grow `check_drift` and `list_recent_changes`, the two tools its own
  header names as unbounded and does not measure, and should declare the synthetic body size so
  the `get_page` figure is not mistaken for a finding again.
- None of this bounds what an agent spends _reading sources_, which dominates the token bill and
  happens through the agent's own file tools, entirely outside accreta's view.

## Implemented as (2026-09-29, #47)

`lint_knowledge_base`, `find_consumers` and `find_canonical` take `limit` (default 50, at most 50)
and `cursor`. They differ from the Decision above in these ways:

- **`count`, not `total`.** The three tools already returned `count`, and it is kept as the
  untruncated total, as F-AIE-04 asked. Renaming it would change a field consumers already read.
  `search_pages` is not changed yet: it still defaults to 20 results, has no cursor, and its
  `count` is the page length. [#183](https://github.com/francescofioredev/accreta/issues/183)
  aligns it.
- **`nextCursor`.** The name MCP gives the field in its own paginated list results. It is absent
  on the last page.
- **A cursor is refused once its results change.** An offset replayed over a changed list would
  skip or repeat results without saying so. Lint binds its cursor to the content of the findings,
  so a changed finding invalidates it even without a reindex. `find_consumers` binds its cursor
  to a random `build_id` the indexer writes to `meta`, so any rebuild invalidates it. An index
  built before `build_id` existed falls back to `last_reindex_at`; an index recording neither
  refuses every cursor.
  `find_canonical` binds to its matches. A refused cursor is an error that says to start over.
- **The kind filter.** `lint_knowledge_base` takes `kinds`, validated against the finding kinds
  that exist, so a misspelt kind is an error rather than an empty, clean-looking report. An empty
  list is refused too, rather than read as every kind. The filter applies before paging, so
  `count` is the filtered total. `pages_checked`, `citations_checked`, `citations_unchecked` and
  `unchecked_reasons` stay whole-pass values under a filter. `unloaded-source` findings, which
  the caller supplies because only it loaded the sources, are paged and filtered with the rest.
- **The CLI returns everything for now.** Core calls without a page return the whole list, and
  `accreta lint`, `consumers` and `canonical` make those calls. CLI paging belongs to the CLI
  lane.

Measured by `bench/mcp-budget.ts` at 1,000 pages: `lint_knowledge_base` went from 159.6KB to
8.4KB and `find_consumers` from 157.3KB to 8.2KB. Both are the same at 100 pages.
