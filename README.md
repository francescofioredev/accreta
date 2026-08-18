# accreta

**A knowledge base your AI agent writes, maintains, and is held accountable for.**

> `accretion` *(n.)* — growth by the gradual accumulation of matter.

> [!NOTE]
> [![npm](https://img.shields.io/npm/v/accreta)](https://www.npmjs.com/package/accreta)
> All six roadmap phases are complete and the pipeline runs end to end —
> see the [worked example](examples/climate/). The API is not yet stable, and two deliberately
> deferred pieces are listed in the [roadmap](#roadmap).

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
- a **CLI** — `init`, `reindex`, `lint`, `drift`, `search`, `show`, `consumers`, `canonical`;
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

[`examples/climate/`](examples/climate/) demonstrates the same machinery over scientific
reports: no symbols, no call graph, no imports. Ten pages, two sources, `lint` clean and
`drift` verifying — including a
[contradiction page](examples/climate/knowledge/contradictions/permafrost-feedback-strength.md)
that records a factor-of-three disagreement between two sources and refuses to resolve it.

The vocabulary there is `source`, `concept`, `finding`, `contradiction`, `synthesis`. No
`module`, no `api`, no `endpoint` — page types are configuration, not code
([ADR-0003](docs/adr/0003-vocabulary-is-configuration.md)).

## Roadmap

| Phase | What | Status |
|---|---|---|
| 1 | Core: indexer, frontmatter, link graph | done |
| 2 | `SourceAdapter` interface, `git` and `fs` adapters | done |
| 3 | MCP server and CLI | done |
| 4 | Hybrid search — measured, and **decided against** | done |
| 5 | Constitution templates and setup skill | done |
| 6 | Demo knowledge base, docs, `v0.1.0` | done |

Two pieces are deferred rather than built, each with a reason and an issue:
[hosted deployment auth and the sync loop](https://github.com/francescofioredev/accreta/issues/21),
and [skill distribution](https://github.com/francescofioredev/accreta/issues/26). Both serve
a deployment story that does not exist yet, and building them now would encode guesses that
become load-bearing before anyone has tested them. Skill distribution waited specifically on
there being a package to install from; that now exists, so the guessing is over and the issue
can proceed on evidence.

## Pages are untrusted input to the model

A knowledge base is text that someone wrote, and an agent reads it into its context. An
instruction written inside a page reaches the model exactly the way the page's actual content
does — through the body, and also through the title, the `aliases`, a wikilink target quoted
back by `lint`, and a search snippet. Reading a page's body and finding it sound establishes
nothing about the other four.

This matters most at one setting. **`ACCRETA_ALLOW_WRITES=1` means any page in the corpus can
direct a write.** The write tool asks for a dry run and a confirming token, and that handshake
is real — it stops an agent writing on impulse, and it cannot be replayed onto a different
edit. But it confirms an intent rather than authorizing one, and an agent acting on an
instruction it read in a page will complete the handshake on its way there. Leave writes off
unless an agent is meant to re-verify pages, and understand that enabling them extends trust
to whoever wrote the corpus.

accreta itself has no outbound network capability — no `fetch`, no HTTP client — so there is
no channel here through which a page could send anything anywhere. That is worth stating
precisely rather than inflating: the corpus is private data and pages are untrusted content,
which is two of the three conditions usually named for this class of problem. The third is
supplied by whatever other tools the agent holds in the same session, and accreta can neither
know nor constrain them. This is a real limitation, not an oversight. Documenting it is not a
control, and nothing here prevents an injection; it tells you what you are trusting when you
decide to trust it. See the
[adversarial review](docs/research/2026-08-review/07-adversarial-content.md).

Progress is tracked on the [project board](https://github.com/users/francescofioredev/projects/1),
one epic per phase.

## Install

```bash
bun add -g accreta          # or: bunx accreta --help
```

Then, in a directory of your own:

```bash
accreta init --preset research   # or codebase, or neither
accreta reindex && accreta lint
```

> **accreta runs on [Bun](https://bun.sh), not Node.** It ships as TypeScript and uses
> `bun:sqlite`, so there is no build step and no Node build to fall back to. The `engines`
> field says so, but neither npm nor Bun enforces it: installed under Node, the CLI fails on
> the first import rather than with a useful message. This is a real limitation, not an
> oversight — see [ADR-0005](docs/adr/0005-ship-typescript-for-bun.md).

## Try it

```bash
bun install
cd examples/climate
bun run ../../packages/cli/src/main.ts reindex   # 10 pages, 27 links
bun run ../../packages/cli/src/main.ts lint      # clean
bun run ../../packages/cli/src/main.ts drift     # up to date, both sources
bun run ../../packages/cli/src/main.ts canonical "ECS"
```

Those run against the repository. With `accreta` installed the same commands work anywhere,
which is what [the packaged CLI is tested for](packages/cli/test/packaging.test.ts): the test
packs the tarballs, installs them outside this repository, and drives the CLI from there.

## Design decisions

Four ADRs in [`docs/adr/`](docs/adr/):

- **[0001](docs/adr/0001-lexical-search-first.md)** — search is lexical, and semantic search
  is **not built**. The benchmark said 85% recall@1 without it. It also found a bug in our own
  index first: aliases were not being indexed, which cost 15 points and looked exactly like
  evidence that lexical search cannot handle synonyms.
- **[0002](docs/adr/0002-source-adapter-interface.md)** — a source is four methods, and
  `changedSince()` must be able to say *I cannot tell*.
- **[0003](docs/adr/0003-vocabulary-is-configuration.md)** — page types and link fields are
  configuration; the schema follows the same rule.
- **[0004](docs/adr/0004-markdown-source-of-truth.md)** — markdown is the source of truth and
  the index is disposable.

Further reading: [architecture](docs/architecture.md),
[writing an adapter](docs/writing-an-adapter.md).

## Contributing

Contributions are welcome, with one request: **open an issue before a pull request.** It
takes a minute and it protects you from building something that does not fit the direction.
New source adapters are the most useful contribution and have their own issue template.

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT — see [LICENSE](LICENSE).
