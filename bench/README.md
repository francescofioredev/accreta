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

# Canonical lookup

`canonical-bench.ts` times `findCanonical` with five probes: an alias on one page, an alias on
a tenth of the pages, a word in every page's frontmatter that no page declares as an alias, a
term that is nowhere, and a title. Each probe checks its match count before it is timed, and
each figure is the median of `--runs` calls (31 by default). It also reports the full rebuild.

```bash
bun run bench:canonical                                  # 1000, 10000
bun run bench:canonical -- --sizes=1000,10000,100000 --builds=5
bun run bench:canonical -- --inserts --builds=9          # insert-only rebuild cost
```

A full rebuild is dominated by file reads and varied by ±17% between runs on one machine, which
hides a cost of a few milliseconds. `--inserts` times only the SQL inserts, in one transaction,
for three schemas taken in alternating order: the whole schema, without the title key, and
without alias rows. The differences are what those two structures add to a rebuild.

**Comparing commits.** The numbers in #82's PR came from this method:
- Extract each commit into its own directory with `git archive <commit> | tar -x -C <dir>`,
  and run `bun install` there.
- Copy this file into each directory. It uses only the public API, so it runs against older
  commits too. `--inserts` needs the current schema.
- Run the commits in rotation, A B C A B C A B C, with the same flags. The corpus is seeded, so
  every run sees the same pages. Report the median of each cell across the rotations.

The machine these ran on had a load average of 7 to 10. Treat the ratios between commits as the
result; absolute times will differ on a quieter machine.

# MCP response budget

The consumer of the MCP server is a language model with a finite context window, so every
token a tool returns is a token unavailable for reasoning. `find_consumers`, `find_canonical`
and `lint_knowledge_base` return one page of at most 50 results, with the untruncated `count`
and a `nextCursor` (ADR-0007). `search_pages` returns at most 50 results, and its `count` is
the number returned. `get_page` returns a whole body, and `check_drift` still returns
everything it finds.

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
bun run bench:mcp -- --body-bytes=1000       # a page body closer to a real one
```

Two figures describe the generator, not accreta, and the output says so:

- **`get_page`** is the page body plus a fixed envelope. Every generated page has the same
  body, 29,889 bytes by default; the page bodies in `examples/climate` run 462–1,488 bytes.
  The run prints the body size, and `--body-bytes` sets it.
- **`find_consumers`** probes a hub that every other page links to. Real link graphs are not
  stars, so its figure is an upper bound, not a typical case.

The token figure is bytes/4 — a rule of thumb for English prose under a BPE tokenizer. JSON
punctuation tokenizes worse than prose, so the estimate understates the real count.
