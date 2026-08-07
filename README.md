# accreta

**A knowledge base your AI agent writes, maintains, and is held accountable for.**

> `accretion` *(n.)* — growth by the gradual accumulation of matter.

> [!WARNING]
> **Status: early development.** The design is settled and the engine it is extracted from
> runs in production, but this repository is being built in public and there is no release
> yet. Nothing here is stable. See the [roadmap](#roadmap).

---

## The idea

Most attempts to give an AI agent knowledge of a large system reach for RAG: embed
everything, retrieve chunks at query time, hope the model assembles them correctly. The
context is rebuilt from scratch on every question, and nothing learned in one session
survives into the next.

accreta takes the other path, following [Karpathy's LLM wiki
pattern](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f): the agent
**compiles** knowledge into a wiki of interlinked markdown pages, once, and then keeps it
current. Cross-references, synthesis, and contradictions are already written down. The
knowledge base is a **compounding artifact**, not a lookup index.

That shift buys three things RAG cannot easily provide:

- **Provenance.** Every non-trivial claim cites the source it came from, down to the line
  range and revision. A page without citations is a page under suspicion.
- **Drift detection.** Each page records the source revision it was last verified against.
  When a source moves, accreta tells you *which pages are now suspect* — the thing
  documentation never does on its own.
- **Refusal to over-synthesize.** When the sources disagree, the agent is instructed to
  record the contradiction rather than silently pick a winner.

## What it is, concretely

A knowledge base is a directory of markdown files with YAML frontmatter and `[[wikilinks]]`.
accreta gives you the machinery around it:

- an **indexer** — SQLite FTS5 full-text index plus a link graph across pages;
- an **MCP server** — so any agent (Claude Code, Cursor, or anything speaking [MCP](https://modelcontextprotocol.io))
  can search, fetch pages, resolve canonical definitions, and run impact analysis;
- **source adapters** — a source is anything with a revision and a way to detect change.
  Git repositories are one kind. Directories of documents are another;
- a **CLI** — `init`, `ingest`, `reindex`, `lint`, `serve`;
- a **constitution** — the operating rules the agent follows when writing pages, versioned
  as a template rather than pasted into a chat.

```
sources (git · files · …) ──► agent writes pages ──► index (FTS5 + links)
        ▲                          with provenance             │
        └───────── drift: which pages did this change invalidate?
                                                               ▼
                                                    MCP server · CLI
```

## Not just code

accreta was extracted from a system that documented a 17-repository backend, so code is the
best-tested case — but the core knows nothing about code. It knows about *sources* that have
a revision and can report what changed.

A companion repository, `accreta-example-climate`, will demonstrate the same machinery over
IPCC reports and open climate datasets: no symbols, no call graph, no commits. If the model
holds there, the abstraction is real. That is the point of building it.

## Roadmap

| Phase | What | Status |
|---|---|---|
| 1 | Core: indexer, frontmatter, link graph | in progress |
| 2 | `SourceAdapter` interface, `git` and `fs` adapters | planned |
| 3 | MCP server and CLI | planned |
| 4 | Hybrid search (lexical + optional semantic) | planned |
| 5 | Constitution templates and setup skill | planned |
| 6 | Demo knowledge base, docs, `v0.1.0` | planned |

Progress is tracked on the [project board](https://github.com/francescofioredev/accreta/projects),
one epic per phase.

## Design decisions

Architectural decisions are recorded as ADRs in [`docs/adr/`](docs/adr/) as they are made.
The first one is why search is lexical by default and semantic only as an opt-in — a
deliberate choice, not a missing feature.

## Contributing

Contributions are welcome, with one request: **open an issue before a pull request.** It
takes a minute and it protects you from building something that does not fit the direction.
New source adapters are the most useful contribution and have their own issue template.

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT — see [LICENSE](LICENSE).
