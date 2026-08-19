# ADR-0001: Lexical search is the default; semantic search stays optional and unbuilt

Status: accepted
Date: 2026-08-08

## Context

Most systems that give an agent knowledge of a corpus reach for embeddings first. accreta's
premise is that a *compiled, cross-referenced* corpus is a different object from a pile of
scraped documents, and that lexical search over it may already be sufficient.

That is a claim about the world, so it needed measuring rather than asserting. This project
forbids describing a change as more accurate without numbers; the rule applies hardest to
the decision that would otherwise be made on fashion.

## The measurement

`bench/` holds an 8-page climate-science corpus — non-code deliberately, since the point is
that accreta is not a code-documentation tool — and 20 queries with hand-written relevance
judgments. Each query names the one page a correct system returns first. The judgments are
the disputable part and are checked in so they can be disputed.

Queries are split by class, because the average is less interesting than where approaches
differ:

- **exact-term** — uses a word the page contains
- **alias** — uses a name the page declares in `aliases`
- **paraphrase** — means the page but shares little vocabulary with it
- **conceptual** — describes the idea without naming it

FTS5 is given every advantage: queries are tokenized, stopped, and joined with `OR`, the most
permissive reading available. The question is whether lexical search is good enough, not
whether it can be handicapped into losing.

### Result

```
LEXICAL (FTS5, porter unicode61) — 20 queries, 8 pages

  recall@1 85%   recall@5 90%   MRR 0.867

  exact-term  n=6   recall@1 100%   MRR 1.000
  alias       n=5   recall@1 100%   MRR 1.000
  paraphrase  n=6   recall@1  50%   MRR 0.556
  conceptual  n=3   recall@1 100%   MRR 1.000
```

### What the first run found

The benchmark's first result was **70% recall@1, with alias queries at 40%**. `ECS` and
`thermal inertia` — names the pages *declare in their own frontmatter* — retrieved nothing.

The cause was not lexical search. `pages_fts` indexed title and body and dropped `aliases`
on the floor. Adding one FTS column moved alias queries from 40% to 100% and the overall
figure from 70% to 85%:

| | aliases unindexed | aliases indexed |
|---|---|---|
| recall@1 | 70% | **85%** |
| alias recall@1 | 40% | **100%** |
| MRR | 0.742 | **0.867** |

**What that table is, stated at its actual strength.** Twenty queries is a small benchmark, and
the percentages carry intervals wide enough to matter. Exactly **3 of the 20 queries change
rank** between the two conditions: `climate forcing` (2 → 1), `ECS` (not found → 1) and
`thermal inertia` (not found → 1). Two of the five alias queries already worked without the
column. McNemar exact two-sided p = 0.25; unpaired Fisher on the alias class, 5/5 versus 2/5,
p = 0.167. Clopper-Pearson 95% intervals: before 2/5 → 5.3–85.3%, after 5/5 → 47.8–100%.
They overlap across most of their range.

So the *statistical* case for the alias column is weak at n=20, and would be dishonest to
present otherwise. The *mechanical* case does not depend on statistics and is what actually
decides it: `ECS` and `thermal inertia` retrieved **nothing** — not a worse rank, no result at
all. A page declaring an alias that appears nowhere in its title or body is unreachable by that
name when the column is unindexed, deterministically and by construction. That is the finding.
The percentages are a small sample; the mechanism is not a sample.

This is the finding that decides the ADR, and it would have been invisible without measuring.
Had the benchmark not been run first, the 40% alias score would have looked exactly like
evidence that lexical search cannot handle synonyms — the classic argument for reaching for
embeddings. The real defect was that the index was discarding editorial metadata the corpus
already contained.

**A curated corpus carries signal a scraped one does not.** Aliases, titles, typed links and
canonical sources are written deliberately. Throwing that away at index time and then
concluding that lexical search is insufficient is a mistake this project is unusually
well-positioned to make, since compiling the corpus is the whole idea.

## Decision

**Lexical search (FTS5) is always on and is the default.** No dependencies, no API keys, no
network, and it runs entirely offline.

**Semantic search is not built.** Not deferred pending effort — not built, because the
measurement does not support building it yet. The `SearchBackend` interface, the `sqlite-vec`
driver and reciprocal rank fusion listed on the epic are all left unwritten.

What the numbers actually say is narrower than "semantic search is unnecessary": on this
corpus, three of four query classes are already at 100% recall@1, and the remaining gap is
**paraphrase at 50%** — six queries, three of which fail. At n=6 that carries a 95% binomial
interval of roughly 12–88%, which cannot discriminate between "lexical search is fine here"
and "lexical search is broken here" — a reason to keep measuring, not a measured gap. It is a
real weakness and exactly where embeddings would help. It is not, on its own, a mandate to
add an embedding pipeline, an extra index, a driver abstraction and a fusion algorithm to a
project whose search is otherwise at 85%.

## Alternatives rejected

**Add semantic search now, behind a flag.** The most tempting option, and the one the epic
was originally written to expect. Rejected because a flag is not free: it doubles the index
format, adds an embedding provider abstraction with a local and a hosted path, and commits
the project to a fusion algorithm — all to improve a class of query that is 30% of this
benchmark. It also weakens the offline guarantee in practice, since the interesting embedding
providers are hosted. Revisit when the paraphrase gap is shown to matter on a real corpus.

**Declare semantic search unnecessary and close the question.** Overclaims. Paraphrase at 50%
is a measured weakness and pretending otherwise would be the same sin as adding the feature
unmeasured, in the opposite direction.

**Improve paraphrase recall lexically first — query expansion, synonym lists.** Not rejected;
deferred. The alias result suggests corpus-side fixes may be cheaper than an embedding
pipeline: a page whose paraphrase keeps missing may simply be missing an alias. That is a
question for a larger corpus, and it is a strictly cheaper experiment than the alternative.

## What would change this decision

Concrete triggers, so this is not relitigated on taste:

1. **Paraphrase recall@1 stays below ~70% on a corpus of a few hundred pages.** The current
   corpus is eight pages; a larger one may make the lexical picture better *or* worse, and
   that is worth knowing before building anything.
2. **A real user's queries look like the paraphrase class more often than this benchmark
   assumes.** The class mix here is a guess about usage, and it is the assumption most likely
   to be wrong.
3. **A cheap local embedding provider makes the offline guarantee survivable.** Most of the
   cost of this feature is the hosted dependency, not the vectors.

Any of these reopens the question. Until one does, the honest position is that the numbers do
not justify the machinery.

## Consequences

- accreta has no embedding dependency and runs entirely offline.
- `aliases` is indexed, and the query layer has a regression test asserting that a declared
  alias is retrievable, so this cannot silently regress.
- `bench/` is checked in with its judgments, so the next person to argue for semantic search
  starts from numbers rather than from scratch — and can attack the judgments if they think
  they are wrong.
- The epic's scope items for `SearchBackend`, `sqlite-vec` and RRF are deliberately not
  delivered. The epic's own "done when" anticipated this: *a documented negative result is
  more useful than an unmeasured feature.*
