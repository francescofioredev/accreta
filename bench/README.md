# Search benchmark

The question ADR-0001 has to answer with numbers rather than intuition: does semantic search
measurably improve retrieval over a *curated, cross-referenced* corpus, or is lexical search
over that corpus already good enough?

The distinction matters because accreta's corpus is not a pile of scraped documents. It is
written by an agent that gives pages titles, aliases and typed links. That editorial work is
exactly what lexical search is weakest without and strongest with.

## What is measured

`queries.json` holds queries paired with the page each should retrieve. The relevance
judgments are the honest part of this: they are written against the corpus by hand, and they
encode a claim about what a right answer is. Any of them can be disputed.

Query classes are deliberately mixed, because the interesting result is not the average but
where the two approaches differ:

- **exact-term** — the query uses a word the page contains
- **paraphrase** — the query means the page but shares little vocabulary with it
- **alias** — the query uses a name the page declares as an alias
- **conceptual** — the query describes the idea without naming it

Reported: recall@1, recall@5, and MRR.

## Running it

```bash
bun run bench/search-bench.ts
```

---

# Scale benchmark

ADR-0004 rejects incremental indexing on the strength of one number: 43ms for 300 pages and
600 links. That measures the corpus the project had, not the corpus it might have — and the
rebuild is not an offline operation. `update_verified_revision` writes markdown and tells the
caller to reindex, so the wholesale rebuild sits inside an agent's verification loop and is
paid for on every pass.

`scale-bench.ts` measures the rebuild and every query path against synthetic corpora spanning
three orders of magnitude, so that "when does this stop working" can be answered with a
threshold rather than an intuition.

The corpora are synthetic, and that is a limitation rather than a detail. What is modelled is
the *shape* the link structure takes — a few hub pages that many things cite, a long tail that
nothing points at — because a uniform random graph would flatter `findRelated` by giving it no
hub to choke on. Page bodies are ~120 words, so FTS5 is indexing something real. The generator
is seeded, so a run can be reproduced exactly.

```bash
bun run bench:scale                          # 100, 1000, 10000
bun run bench:scale -- --sizes=100,1000      # pick your own
```

The 100,000-page case takes about twelve minutes, most of it in corpus generation.

# MCP response budget

The consumer of the MCP server is a language model with a finite context window, so every
token a tool returns is a token unavailable for reasoning. Only `search_pages` bounds its
response. `get_page` returns a whole body, and `find_consumers`, `find_canonical`,
`check_drift` and `lint_knowledge_base` return everything they find.

Whether that matters is not a matter of opinion. `mcp-budget.ts` serialises each tool's
response exactly as the server does — `JSON.stringify(value, null, 2)`, whitespace included —
and reports bytes, estimated tokens, and the share of a 200k-token context window one call
consumes.

The failure it exists to quantify is circular: an agent calls `lint_knowledge_base` to find
out what is wrong with the knowledge base *in order to fix it*, and the answer does not fit in
the context it would need to do the fixing.

The generated corpus is deliberately in a half-finished-ingest state, so most pages produce a
lint finding. That is the state a knowledge base is in when an agent most needs to lint it.

```bash
bun run bench:mcp                            # 10, 100, 1000
bun run bench:mcp -- --sizes=10,100,1000
```

The token figure is bytes/4 — a rule of thumb for English prose under a BPE tokenizer. JSON
punctuation tokenizes worse than prose, so the estimate understates the real count.
