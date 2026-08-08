# ADR-0004: Markdown is the source of truth; the index is derived and disposable

Status: accepted
Date: 2026-08-08

## Context

The knowledge base has to be two things at once: a set of documents people read and edit, and
a queryable structure an agent traverses. Those pull in different directions — the first
wants plain files in git, the second wants indexes and joins.

## Decision

**Markdown files are the source of truth.** They live in the repository, diff in review,
render on GitHub, and are editable with any editor. Frontmatter carries structure; wikilinks
carry the graph.

**The SQLite index is derived and disposable.** It is rebuilt wholesale from the markdown, is
gitignored, and is never migrated. Changing `schema.sql` means the next rebuild produces the
new shape — that is the entire migration story.

Three consequences follow deliberately:

**Rebuilds are wholesale, not incremental.** A `DELETE` and reinsert of every page inside one
transaction. Measured at 43ms for 300 pages and 600 links. Delta tracking would save
milliseconds and add a class of bug where the index disagrees with the files and nothing
notices — the worst possible trade for a system whose purpose is not quietly being wrong.

**The write tool edits markdown, not the index.** `update_verified_revision` rewrites the
page and asks for a reindex. Writing to the index directly would put it out of step with the
files it is derived from.

**Frontmatter is edited a line at a time**, never parsed and reserialized. Reserializing
reorders keys, normalizes quotes, and destroys the `field: [[wikilink]]` syntax that renders
as a link on GitHub — the syntax the parser's preprocessing pass exists to accommodate.

## Alternatives rejected

**A database as the source of truth, with markdown exported.** Better queries, and it makes
the knowledge base unreviewable. A pull request against a knowledge base should show what
changed in the words; against a database it shows nothing useful. It also puts the corpus
behind a tool, when the point is that it survives one.

**Markdown alone, no index, grepping at query time.** Genuinely tempting at small scale, and
it fails on the graph. "What links here" over inline wikilinks *and* typed frontmatter
relations, in both directions, is a join. Rebuilding it per query at query latency is worse
than rebuilding it once in 43ms.

**Incremental index updates on file change.** Rejected above: the saving is milliseconds and
the cost is a staleness bug that fails silently, which is this project's characteristic
failure mode already.

**Committing the index.** A binary blob in every diff, stale the moment anyone edits a page,
and merge conflicts nobody can resolve. Gitignored instead.

## Consequences

- The knowledge base outlives this tool. Delete accreta and the pages are still readable
  markdown with citations.
- A rebuild is required after any write, and the CLI says so rather than hiding it.
- The index can be deleted at any time with no loss. `accreta reindex` restores it.
- A reader holding an open connection across a rebuild must reopen; the behaviour differs by
  platform and the tests assert only what holds everywhere. See `docs/architecture.md`.
- Rebuild cost grows linearly with corpus size. At a few hundred pages it is imperceptible;
  at a hundred thousand this decision would need revisiting, and nothing about the current
  design would survive that scale anyway.
