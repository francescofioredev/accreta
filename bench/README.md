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
bun run bench
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

Whether that matters is not a matter of opinion. `mcp-budget.ts` connects a client to the
server over an in-memory MCP transport, calls each tool by name, and measures the text block
the server returns, whitespace included. It reports bytes, estimated tokens, and the share of
a 200k-token context window one call consumes. The JSON-RPC message that carries the text
escapes it again and adds its own framing, so the bytes on the wire are somewhat more.

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
  body, 29,889 bytes by default. The ten pages in `examples/climate` have bodies of 462–1,488
  bytes as the indexer parses them, and are 756–1,782 bytes as whole files, frontmatter
  included. The run prints the body size, and `--body-bytes` sets it; it refuses fewer than 34
  bytes, which would cut the word `search_pages` probes for.
- **`find_consumers`** probes a hub that every other page links to. Real link graphs are not
  stars, so its figure is an upper bound, not a typical case. `find_canonical` probes an alias
  every page shares, for the same reason.

The token figure is bytes/4 — a rule of thumb for English prose under a BPE tokenizer. JSON
punctuation tokenizes worse than prose, so the estimate understates the real count.

## The budget gate

`test/response-budget.test.ts` runs in `bun test`, and so in CI. It calls `measure(60)`: the
smallest round size where every list tool has more results than fit in one default page. Past
that size a default response is still one page, so the bytes barely move: at 1,000 pages each
figure is within 1.1% of its value at 60. The test takes under a second. It fails when:

- a list tool returns more than 50 entries by default, the limit ADR-0007 sets;
- a default response grows past its byte budget;
- `check_drift` names a changed path more than once per stale revision, or grows past its
  size, per-page or per-path budget.

| response                                    | at 60 pages | budget | headroom per entry |
| ------------------------------------------- | ----------- | ------ | ------------------ |
| `search_pages`, body word                   | 7,120       | 7,400  | 14 B per hit       |
| `search_pages`, shared alias                | 8,696       | 9,000  | 15 B per hit       |
| `find_consumers`, the hub                   | 8,478       | 9,300  | 16 B per relation  |
| `find_consumers`, inbound and outbound      | 8,498       | 9,300  | 16 B per relation  |
| `find_canonical`                            | 9,443       | 10,300 | 17 B per match     |
| `lint_knowledge_base`                       | 8,727       | 9,600  | 17 B per finding   |
| `get_page`, minus its body                  | 1,069       | 1,100  | 31 B in all        |

Bytes of the text block the server returns, darwin arm64, Bun 1.3.13. Each budget is the
size measured when the gate was added plus 10%, rounded up to the next 100 bytes; the
`_provenance` labels added since cost the difference. The margin is a tolerance, not room
for noise: the output at 60 pages is deterministic, so the same code always measures the same
bytes. `search_pages` returns 20 entries rather than 50, so 10% would leave each hit 40 B; its
budgets allow 18 B per hit instead, in line with the other tools. A field added to every entry
fails once it costs more than the last column: `"matched_aliases": []` on every search hit
costs 29 B. ADR-0007 states a size only for lint (8.5KB, which the measurement matches).

Two probes exist only for the gate. The aliased search matches every page, which the test
checks against the index, so every hit carries `matched_aliases`. The second `find_consumers`
probe has 30 inbound relations and 29 outbound, so its default page holds both and the limit
cuts the outbound ones. `get_page` is gated without its body, because the body is the caller's
page, not accreta's overhead. `search_pages` still returns 20 results by default; aligning it
to 50 (#183) has to raise its budget in the same change.

`check_drift` is not paged. It is gated on its size at 100 pages and 50 changed paths, and on
what 100 more pages or 50 more changed paths add, each plus 10%. Pages cite into the changed
paths, and a scripted source reports them. The size cap matters because the marginal checks
alone would miss anything that adds a fixed amount.

The gate runs `check_drift` in two modes, because the tool reports them differently. With
diffs, the source says what each change did to each cited line, as the git adapter does, and
every git report takes this path. Without diffs, the report lists only pages and paths.

| mode                                           | size    | per page | per path |
| ---------------------------------------------- | ------- | -------- | -------- |
| with diffs, 1 revision, 1 citation per page    | 27,490  | 241      | 38       |
| with diffs, 2 revisions, 2 citations per page  | 45,581  | 397      | 76       |
| without diffs, 1 revision                      | 7,163   | 40       | 38       |
| without diffs, 2 revisions                     | 9,192   | 40       | 76       |

One revision is what a git ingest leaves: every page verified in one run records the same HEAD.
The two-revision cases make growth by revision, and by citations times changed paths, show.
Each of these was reproduced by rewriting the response at run time, and each fails the gate:

- copying the changed paths into every page (the multiplier ADR-0007 removed);
- copying them onto every citation;
- adding a field for every page.

A response that grows on purpose raises its budget in the same pull request, where a reviewer
sees it. `list_recent_changes` is not gated: the benchmark does not measure it.
