# ADR-0007: A tool response is a context-window budget, and four of ours have none

Status: proposed
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

**Pick the default limit now.** Deliberately not decided. A bounded lint may cause an agent to
fix _fewer_ findings, if paging costs turns and it stops early believing it is done. That is
measurable — findings fixed per session, bounded versus unbounded, on the same seeded corpus —
and the experiment is designed. Shipping the mechanism does not require guessing the number.

## Consequences

- `check_drift`'s response shape changes. The CLI and any consumer must read the grouped form.
- Callers of the bounded tools must handle truncation; the total makes that possible without
  guessing.
- `bench/mcp-budget.ts` should grow `check_drift` and `list_recent_changes`, the two tools its own
  header names as unbounded and does not measure, and should declare the synthetic body size so
  the `get_page` figure is not mistaken for a finding again.
- None of this bounds what an agent spends _reading sources_, which dominates the token bill and
  happens through the agent's own file tools, entirely outside accreta's view.
