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
bun run bench:scale -- --identifiers=10      # every 10th body word is an identifier like forcing_feedback
```

`--identifiers` keeps the link graph unchanged. It adds a plain search for `forcing_feedback`
and prints the index size in bytes, which is the cost of the identifier table (#275).

# Identifier queries

`identifier-bench.ts` runs 22 plain queries over `identifiers/`, a 15-page corpus of metric,
column and setting names. Its relevance judgments were committed before any variant of identifier
search was run. It reports recall@1, MRR, recall@10 (the share of relevant pages in the top ten)
and how many queries returned nothing. `--verbose` prints every ranking.

```bash
bun run bench:identifiers -- --verbose
```

`bun run bench` cannot see identifier handling: its queries have no underscores, and it uses the
FTS5 syntax that bypasses the identifier table.

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

# Drift per source

`drift-bench.ts` times `detectDrift` per source over 10 sources, at 1,000 and 10,000 pages. Each
page cites its own source and two others in footnotes, and one page in twenty names another
source in `canonical_source`. It also times the two queries `citationsInto` runs, prints their
`EXPLAIN QUERY PLAN`, the rebuild and the index size. Each figure is the median of 7 runs over
every source.

```bash
bun run bench:drift                                       # Bun, from source
bun run --cwd packages/core build && node --experimental-strip-types bench/drift-bench.ts
```

Node reads the built `dist/`, so rebuild it after changing core. The canonical query is copied
from `drift.ts`; keep the two in step. On an index without `canonical_cites` it runs the `instr()`
scan drift ran before #239, so the same file measures either side.

**Before and after #239.** Extract the commit before it with
`git archive <commit> | tar -x -C <dir>`, run `bun install` there, copy this file into its
`bench/`, and run both directories with the same command. Median of 5 runs, Apple M3, 16 GB:

| | Bun 1.4.2 before → after | Node 22.16.0 before → after |
| --- | --- | --- |
| drift per source, 1k pages | 0.60 → 0.24 ms | 1.17 → 0.42 ms |
| drift per source, 10k pages | 17.41 → 1.84 ms | 15.48 → 3.55 ms |
| canonical query, 10k | 8.22 → 0.01 ms | 5.89 → 0.01 ms |
| footnote query, 10k | 5.89 → 0.66 ms | 5.41 → 1.17 ms |
| index file, 1k | 5,632,000 → 5,836,800 B (+3.6%) | 5,623,808 → 5,824,512 B (+3.6%) |
| index file, 10k | 55,762,944 → 57,798,656 B (+3.7%) | 55,812,096 → 57,774,080 B (+3.5%) |
| rebuild | no measurable change | no measurable change |

**Before and after #303.** Drift asks `locate` about every citation it would rank untouched. The
`by lines` column times a source that also answers `touchedSince`; `locates` is the mean number of
`locate` calls per source per run. Footnotes cite one of 50 ranges in one of 200 files, so up to
10,000 distinct places. The bench's `locate` costs nothing, so a real source adds its own cost per
call on top. Medians of 5 interleaved runs, Bun 1.4.2, Apple M3, 16 GB:

| | before → after |
| --- | --- |
| drift per source, 1k pages | 0.23 → 0.27 ms (175 locates) |
| drift per source by lines, 1k pages | 0.24 → 0.33 ms (315 locates) |
| drift per source, 10k pages | 1.81 → 2.23 ms (1,629 locates) |
| drift per source by lines, 10k pages | 1.87 → 2.69 ms (2,617 locates) |

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
escapes it again and adds its own framing, so the bytes on the wire are more. `search_pages`
and `get_page` also return the same JSON as `structuredContent`, so they carry their results or
body twice on the wire.

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

`test/response-budget.test.ts` runs in `bun run test`, and so in CI. It calls `measure(60)`: the
smallest round size where every list tool has more results than fit in one default page. Past
that size a default response is still one page, so the bytes barely move: at 1,000 pages each
figure is within 1.1% of its value at 60. The test takes under a second. It fails when:

- a list tool returns more than 50 entries by default, the limit ADR-0007 sets;
- a default response grows past its byte budget;
- `check_drift` names a changed path more than once per stale revision, or grows past its
  size, per-page or per-path budget.

| response                                    | at 60 pages | budget | headroom per entry |
| ------------------------------------------- | ----------- | ------ | ------------------ |
| `search_pages`, body word                   | 5,875       | 6,300  | 21 B per hit       |
| `search_pages`, shared alias                | 6,791       | 7,200  | 20 B per hit       |
| `search_pages` on the wire                  | 12,368      | 13,700 | 66 B per hit       |
| `find_consumers`, the hub                   | 8,478       | 9,300  | 16 B per relation  |
| `find_consumers`, inbound and outbound      | 8,498       | 9,300  | 16 B per relation  |
| `find_canonical`                            | 9,443       | 10,300 | 17 B per match     |
| `lint_knowledge_base`                       | 8,727       | 9,600  | 17 B per finding   |
| `get_page`, minus its body                  | 850         | 1,000  | 150 B in all       |
| `get_page` on the wire, minus both bodies   | 1,876       | 2,100  | 224 B in all       |

Bytes of the text block the server returns, darwin arm64, Bun 1.4.2. The wire rows count the
whole JSON-RPC response, serialized as the stdio transport sends it, without its newline. Each
budget is the size measured when the gate was added plus 10%, rounded up to the next 100 bytes;
the `_provenance` labels added since cost the difference. The `search_pages` and `get_page` text
rows were set again when that text went compact (#131), which cut 17% and 20% from them. The
margin is a tolerance, not room for noise: the output at 60 pages is deterministic, so the same
code always measures the same bytes. `search_pages` returns 20 entries rather than 50, so 10%
would leave each hit 29 B; its text budgets allow 18 B per hit instead, in line with the other
tools. A field added to every entry fails once it costs more than the last column: a 25 B field
on every search hit fails both text rows, while `"matched_aliases":[]` on every hit would cost
21 B and pass the body-word row by 5 B. The search wire row keeps the plain 10%: a field costs it
about twice, once in each copy, so that 25 B field adds 54 B per hit there and passes; the text
rows are what catch it. ADR-0007 states a size only for lint (8.5KB, which the measurement
matches).

Two probes exist only for the gate. The aliased search matches every page, which the test
checks against the index, so every hit carries `matched_aliases`. The second `find_consumers`
probe has 30 inbound relations and 29 outbound, so its default page holds both and the limit
cuts the outbound ones. `get_page` is gated without its body, because the body is the caller's
page, not accreta's overhead. Its text block cannot show the body's second copy, in
`structuredContent`, so it is gated on the wire too, minus both copies. `search_pages` has no
body, so its wire row is the whole response. `search_pages` still
returns 20 results by default; aligning it to 50 (#183) has to raise its budget in the same
change.

`check_drift` is not paged. It is gated on its size at 100 pages and 50 changed paths, and on
what 100 more pages or 50 more changed paths add, each plus 10%. Pages cite into the changed
paths, and a scripted source reports them. The size cap matters because the marginal checks
alone would miss anything that adds a fixed amount.

The gate runs `check_drift` in two modes, because the tool reports them differently. With
diffs, the source says what each change did to each cited line, as the git adapter does, and
every git report takes this path. Without diffs, the report lists only pages and paths.

| mode                                           | size    | per page | per path |
| ---------------------------------------------- | ------- | -------- | -------- |
| with diffs, 1 revision, 1 citation per page    | 27,643  | 241      | 38       |
| with diffs, 2 revisions, 2 citations per page  | 45,734  | 397      | 76       |
| without diffs, 1 revision                      | 7,316   | 40       | 38       |
| without diffs, 2 revisions                     | 9,345   | 40       | 76       |
| with diffs, cited-only, 1 revision             | 33,439  | 361      | 38       |
| with diffs, cited-only, 2 revisions            | 51,568  | 517      | 76       |
| without diffs, cited-only, 1 revision          | 14,193  | 176      | 38       |
| without diffs, cited-only, 2 revisions         | 18,299  | 216      | 76       |
| with diffs, cited-only, pinned twice           | 57,692  | 639      | 76       |
| without diffs, cited-only, pinned twice        | 25,099  | 352      | 76       |

Bytes of the text block, darwin arm64, Bun 1.4.2. One revision is what a git ingest leaves:
every page verified in one run records the same HEAD. The two-revision cases, which also cite
two paths per page, make growth by revision, and by citations times changed paths, show.

In the cited-only rows, the 100-page base alternates: every odd page belongs to another source
and cites this one through a footnote pinned at a stale revision, and both kinds of page spread
over every revision. The 100 extra pages are all cited-only, so per page is what one cited-only
page costs. Half of the cited-only pages also point their `canonical_source` at the lines their
footnote cites. Those pages are listed in `cited_only`, and without diffs `cited_paths` names
the changed paths each one cites. The benchmark checks both against what it generated, so the
gate counts each changed path once per stale revision, once per listed citation and once per
cited-only page that cites it. A field added to every cited-only page fails once it costs more
than 10% of its per-page figure: 18 B and 22 B without diffs, 36 B and 52 B with diffs, at one
and two revisions.

In the pinned-twice rows, every cited-only page pins its second footnote at the other
revision, so it sits in both groups. `check_drift` lists it once per pin: in `pages`,
`cited_only` and `pages_by_change` or `cited_paths` of each group, with only the citations
pinned there. Against the same pages pinned once, that adds 136 B per page without diffs and
122 B with diffs, past the two-revision cited-only budgets, so these rows have their own; their
10% thresholds are 35 B and 64 B per page. The cost grows per pin, not per revision: at three
revisions with two pins it stays at 352 B and 638.72 B per page. The probe checks each distinct
group's pages, `cited_only` and `cited_paths` against the pins that put them there, and
`repetition` checks that the corpus really pins pages twice. Which group each citation lands in
is covered by core's `drift-cross-source.test.ts`, not here.

Each of these was reproduced by rewriting the response at run time, and each fails the gate:

- copying the changed paths into every page (the multiplier ADR-0007 removed);
- copying them onto every citation;
- copying them onto every cited-only page;
- adding the revision to every citation of a cited-only page, with diffs (+39 B per page);
- adding a field for every page.

A response that grows on purpose raises its budget in the same pull request, where a reviewer
sees it. `list_recent_changes` is not gated: the benchmark does not measure it.
