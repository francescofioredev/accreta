# Architecture

How accreta is put together, and why. This is the working reference for anyone building on
the project; conceptual background lives in the README, and individual decisions are
recorded in [`adr/`](adr/).

---

## The shape

```
┌──────────────────────────────────────────────────────────┐
│  Sources (pluggable)                                     │
│  ┌──────────┐  ┌──────────┐  ┌───────────┐               │
│  │ git      │  │ fs       │  │ delegated │  the agent    │
│  │ adapter  │  │ adapter  │  │ adapter   │  reads this   │
│  └────┬─────┘  └────┬─────┘  └────┬──────┘               │
└───────┼─────────────┼─────────────┼──────────────────────┘
        └─────────────┴─────────────┘
                      │  SourceAdapter:
                      │   revision() · changedSince() · locate() · citation()
                      ▼
        ┌─────────────────────────────┐
        │  Knowledge base (markdown)  │  ← the agent writes here,
        │  frontmatter + wikilinks    │     always with provenance
        └──────────────┬──────────────┘
                       │ indexer
                       ▼
        ┌─────────────────────────────┐
        │  Index (SQLite)             │
        │  pages · pages_fts · links  │
        └──────────────┬──────────────┘
                       │
        ┌──────────────┴──────────────┐
        │  MCP server  ·  CLI         │
        └─────────────────────────────┘
```

The index is derived and disposable: it rebuilds from the knowledge base in well under a
second for a few hundred pages, so it is never committed and never migrated.

## The two abstractions

### `SourceAdapter`

A source is anything that can answer three questions — what revision are you at, what changed
since a given revision, and is this location really inside you — plus one instruction: cite
against *this* revision.

```ts
interface SourceAdapter {
  id: string;
  revision(): Promise<string>;                    // sha, mtime hash, etag…
  changedSince(rev: string): Promise<string[]>;   // changed paths
  locate(path: string, locator?: string): Promise<LocationVerdict>;  // found/missing/unknown
  citation(path: string, locator?: string): string;
  pinRevision(rev: string): void;                 // what citations name
}
```

Git answers with a commit SHA and `diff --name-only`. A directory of documents answers with
a hash of modification times and a scan. An API might answer with an ETag and a changes
feed.

Drift detection — the feature the project is really about — depends only on `revision()` and
`changedSince()`. It never learns what kind of source it is looking at.

> **The invariant**: nothing in `packages/core` may branch on adapter identity. An
> `if (adapter === 'fs')` in the core means the interface is missing something. Extend the
> interface; do not special-case the caller.

### Page schema from configuration

A knowledge base about climate science should not have to describe itself with page types
invented for source code. Vocabulary is configuration:

```yaml
page_types: [note, source, concept, decision, synthesis]
link_fields: [related, consumed_by, supersedes, discussed_in]
provenance:
  format: "{source} @ {rev} · {path}#{locator}"
```

Code-oriented types (`repository`, `module`, `api`, `usecase`, `integration`) ship as the
`codebase` preset.
They are a preset precisely because they are not universal.

## Search

Search is SQLite FTS5 over each page's title, aliases and body, with Porter stemming. It needs
no dependencies, no keys and no network, and there is no `search` configuration key.

Semantic search is **not built**. [ADR-0001](adr/0001-lexical-search-first.md) measured 85%
recall@1 without it and keeps it optional and unbuilt until a benchmark says otherwise.

## Pages

A page is markdown with YAML frontmatter:

```markdown
---
type: concept
canonical_source: ipcc-ar6-wg1:chapter-07.md#L142
aliases: ["radiative forcing", "climate forcing"]
discussed_in: [[synthesis/energy-balance]]
last_verified_revision: 9a4f2c1
---

# Radiative forcing

The change in net downward radiative flux at the tropopause…[^src]

[^src]: ipcc-ar6-wg1 @ 9a4f2c1 · chapter-07.md#L142-L158
```

Two kinds of link feed one graph: **frontmatter relations** (typed, from `link_fields`) and
**inline `[[wikilinks]]`** (untyped, from the body). Both are indexed, so impact analysis can
answer "what depends on this" across either.

`canonical_source` is what makes "what is the authoritative definition of X" answerable, and
`last_verified_revision` is what makes drift detectable. A page missing both still renders
fine and is nearly useless.

A pointer that *is* present is checked rather than trusted, whether it is `canonical_source`
or a footnote. Footnotes are read back through the knowledge base's own `provenance.format`,
and indexed with the sentence that cites them. `lint` asks the source, through
`SourceAdapter.locate`, whether the path and locator exist. Where the source keeps history, it
also asks whether the cited revision does. All of it is deterministic. What none of it can tell
is whether a range that exists supports the claim made from it. That needs reading both, and is
not attempted.

## The index

Six tables. `pages` holds frontmatter fields promoted to columns for filtering, plus the
full frontmatter as JSON and the body. `pages_fts` is an FTS5 virtual table over title, aliases
and body. `links(src, dst, kind)` is the graph. `broken_links` keeps every link that did not
resolve, because that is what `lint` reports. `citations` holds one row per footnote, with the
sentence it cites; a footnote that does not parse as `provenance.format` is kept with no source,
so `lint` can report it. `meta` holds build metadata.

Rebuilds are wholesale rather than incremental: a full delete-and-reinsert inside one
transaction. At this corpus size delta tracking would add failure modes to save milliseconds.

Every rebuild happens beside the live index and is moved into place with
`rename(2)`, which is atomic within a filesystem. A reader either sees the whole old index or
the whole new one; the path never names a half-rebuilt database.

A connection that outlives the swap is a different matter, and the outcome depends on the
platform. On Linux the unlinked inode stays alive behind the open descriptor, so a stale
handle keeps serving the old rows; on macOS SQLite revalidates the file and fails that
connection with `SQLITE_IOERR`. Both behaviours were observed against the same code, one
locally and one in CI.

A long-lived reader therefore has to reopen after a rebuild rather than rely on either. The MCP
server's context does this: it compares the index's `dev:ino` before each use and reopens when
`rename(2)` has changed it, asking the filesystem rather than the connection — one that is
already failing cannot be asked, and a stale one on Linux would answer with the old value. See
[ADR-0010](adr/0010-readers-revalidate-by-inode.md).

## Surfaces

**MCP server**, for agents:

| Tool | Purpose |
|---|---|
| `search_pages` | Full-text search with type and source filters. The primary discovery tool. |
| `get_page` | Fetch frontmatter and body by path or wikilink target. |
| `find_consumers` | Impact analysis across the link graph, inbound and outbound. |
| `find_canonical` | Resolve a concept, including aliases, to its authoritative page. |
| `check_drift` | Compare a source's current revision against what pages were verified at. |
| `list_recent_changes` | What changed in a source since a given revision. |
| `lint_knowledge_base` | Broken links, unknown page types, missing provenance, citations that do not resolve. |
| `update_verified_revision` | Write tool. Off unless `ACCRETA_ALLOW_WRITES=1`; dry run, then confirm token. |

**CLI**, for humans: `init`, `reindex`, `lint`, `drift`, `doctor`, `source add`, `search`,
`show`, `consumers`, `canonical`. `accreta help` lists their flags.

## Where the method lives

The rules an agent follows while maintaining a knowledge base are not documentation — they
are its program. They live in `templates/constitution/`, versioned and composable: `base.md`
carries the method with no assumptions about source type, and presets add domain vocabulary.
`accreta init` composes them into the `AGENTS.md` or `CLAUDE.md` of the target project.

The rules that must survive every refactor:

- Every non-trivial claim carries a citation to source, path, lines, and revision.
- Never duplicate the source into the knowledge base; cite it.
- Never write a speculative page — a concept needs at least two real points of contact.
- When sources disagree, record the contradiction. Do not choose a winner.
