# accreta

**A knowledge base your AI agent writes, maintains, and is held accountable for.**

> `accretion` *(n.)* — growth by the gradual accumulation of matter.

> [!NOTE]
> [![npm](https://img.shields.io/npm/v/accreta)](https://www.npmjs.com/package/accreta)
> All six roadmap phases are complete and the pipeline runs end to end —
> see the [worked example](examples/climate/). The API is not yet stable, and one deliberately
> deferred piece is listed in the [roadmap](#roadmap).

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
  Git repositories are one kind, directories of documents another. The third kind inverts who
  does the work: a source **only your agent can reach**, which accreta declares and never
  touches;
- a **CLI** — `init`, `reindex`, `lint`, `drift`, `doctor`, `source add`, `search`, `show`,
  `consumers`, `canonical`;
- a **constitution** — the operating rules the agent follows when writing pages, versioned
  as a template rather than pasted into a chat.

```
sources (git · files · connectors) ──► agent writes pages ──► index (FTS5 + links)
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

## Sources your agent reads for you

Not every corpus is on disk. A wiki, a mailbox, a tracker — accreta declares those and
**never touches them**: no credential, no network call, no provider name anywhere in the code.

```yaml
# sources/design-docs.yaml
id: design-docs
type: delegated
via: notion              # the connector your agent needs; accreta never interprets it
scope: |                 # prose your agent reads, and the only definition of what is in scope
  The "Design decisions" page and everything below it.
```

There is no `notion` type and no `gmail` type. A mailbox is the same declaration with a
different connector, which is the test of whether the generalization is real:

```yaml
# sources/support-threads.yaml
id: support-threads
type: delegated
via: gmail
scope: |
  Threads labelled "escalations" from 2026 onward.
  A message is immutable, so what changes is not a cited claim but that the thread continued:
  look for new messages in a cited thread, not for edits to a cited one.
```

accreta still knows which pages cite the source and at which revision, so `drift` produces a
work order instead of a verdict:

```
design-docs — read through notion by the agent, not by accreta
  3 page(s) for the agent to re-verify there:
    knowledge/concepts/pricing.md (verified at 2026-08-01T10:22:00Z)
  in scope:
    The "Design decisions" page and everything below it.
```

**What this costs, stated where you choose it:**

- **`drift` exits 0** — nothing is *known* to be wrong. So a knowledge base with delegated
  sources cannot be gated on drift in CI. Use `accreta drift --strict`, which exits 1 on
  anything left unchecked.
- **`lint` cannot check a citation into one.** It counts them. An invented page id and a real
  one look identical from here, so those citations are only as good as your agent's reading was.
- **It needs the setup skill in front of your agent**, because the agent is what does the
  reading. One command installs it; see below.

## Roadmap

| Phase | What | Status |
|---|---|---|
| 1 | Core: indexer, frontmatter, link graph | done |
| 2 | `SourceAdapter` interface, `git` and `fs` adapters | done |
| 3 | MCP server and CLI | done |
| 4 | Hybrid search — measured, and **decided against** | done |
| 5 | Constitution templates and setup skill | done |
| 6 | Demo knowledge base, docs, `v0.1.0` | done |

One piece is deferred rather than built.
[Hosted deployment auth and the sync loop](https://github.com/francescofioredev/accreta/issues/21)
serves a deployment story that does not exist yet, and building it now would encode guesses that
become load-bearing before anyone has tested them.

One was closed without being built.
[Skill distribution](https://github.com/francescofioredev/accreta/issues/26) asked for an
installer that placed the setup skill and handled the five states a target can be in — the
interesting two being a copy the user had edited and a filename something else already owned.
It waited on there being a package to install from. What arrived instead was a channel:
`npx skills` already finds this repository's layout, installs per agent, and updates. Writing
our own would mean owning a policy about whose edits win, for a problem we no longer have. What
that channel does *not* solve is written down where a user meets it, above, rather than left to
be discovered — see [ADR-0013](docs/adr/0013-skill-distribution-is-not-ours.md).

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

The setup skill that walks an agent through the rest is a separate install, from this
repository rather than from npm — see [step 4](#a-knowledge-base-of-your-own-end-to-end).

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

## A knowledge base of your own, end to end

Over a source only your agent can reach, which is the case that needs the most explaining. Every
step is a command or a named file.

**1. Start one.**

```bash
bun add -g accreta
mkdir my-kb && cd my-kb
accreta init --preset research
```

**2. Declare the source.** `--set` pairs go into the declaration untouched — accreta knows no
more about a source's options than you do.

```bash
accreta source add delegated design-docs --set via=notion
```

It writes `sources/design-docs.yaml` and tells you it is not usable yet:

```
Wrote sources/design-docs.yaml
  no: declares no `scope`
    → Add `scope:` — prose your agent reads. Nothing else says what it may look at.
```

That is deliberate. An empty scope means either nothing or everything, so it is refused rather
than guessed at. Open the file and fill it in:

```yaml
scope: |
  The "Design decisions" page and everything below it.
```

**3. Check both sides.**

```bash
accreta doctor
```

```
sources (1)
  design-docs — delegated
    unknown: accreta cannot check this source; notion can
    your agent needs: notion — unverified
      → Nothing on this machine records whether your agent can reach notion.
```

`unknown` is not a failure, and `doctor` exits 0 on it. A connector authorized in your agent
lives in no file here, so calling it absent would be exactly as wrong as calling it present.
**The one thing that can settle it is your agent**, by reading the declared scope once and
saying what came back.

**4. Give your agent the skill.** The setup skill lives in this repository and installs with
[`npx skills`](https://github.com/vercel-labs/skills). Pin it to the release you are running,
so the file and the CLI cannot disagree:

```bash
npx skills add "https://github.com/francescofioredev/accreta/tree/v$(accreta --version)/skills/accreta-setup"
```

Or take the current one, which may describe commands your installed version does not have yet:

```bash
npx skills add francescofioredev/accreta --skill accreta-setup   # -g for every project
npx skills update accreta-setup                                  # when a release moves
```

This is the step with a rough edge, so it is stated plainly rather than glossed:

- **The unpinned form installs from `main`, not from the version you have.** The skill's
  `metadata.requires` names the earliest release that has every command it uses; if one is
  missing, that field and `accreta --version` are how you find out, rather than by the command
  failing halfway through a setup.
- **`npx skills update` overwrites your copy without asking.** Its lock file stores a hash of
  what it installed, so it could tell that you edited the file, and it does not: an edit made
  in the skills directory is gone after the next update, silently. Keep anything you want to
  survive somewhere else.
- **`npx skills` is not ours**, and a skill is instructions your agent will follow. Read it
  before use, the way you would any dependency. The package also carries its own copy at
  `node_modules/accreta/skills/accreta-setup/`, version-locked to the code beside it, for
  anyone who would rather not run a fetch at all.

**5. Let the agent write the pages.** No tool does this part. The agent follows the constitution
in `AGENTS.md`: read the source through its connector, write pages that cite what they came
from, and record the revision each claim was checked against.

**6. Check the result.**

```bash
accreta reindex
accreta lint      # also prints the citations it could not check, and why
accreta drift     # a work order for the delegated source, exit 0
```

**7. Keep it current.** `accreta drift` lists the pages waiting to be re-verified and the
revisions they are stuck at. The agent reads those locations again, fixes what changed, and
records the new revision. Re-verifying means reading the source again — bumping the revision
because the report mentioned the page is the one move that turns a detectable problem into an
undetectable one.

In CI, use `accreta drift --strict`: it exits 1 on anything left unchecked, so a pipeline can
demand "nothing unverified" without anyone pretending the source was inspected.

## Design decisions

Thirteen ADRs in [`docs/adr/`](docs/adr/). The ones that decide the shape:

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
- **[0011](docs/adr/0011-a-citation-points-at-a-locator.md)** — a citation points at a locator
  the source defines, and accreta never reads a source.
- **[0012](docs/adr/0012-a-source-only-the-agent-can-reach.md)** — a source behind a connector
  is declared, not fetched. accreta holds no credential.
- **[0013](docs/adr/0013-skill-distribution-is-not-ours.md)** — the setup skill installs through
  `npx skills`, and the installer we specified is **not built**.

Further reading: [architecture](docs/architecture.md),
[writing an adapter](docs/writing-an-adapter.md).

## Contributing

Contributions are welcome, with one request: **open an issue before a pull request.** It
takes a minute and it protects you from building something that does not fit the direction.
New source adapters are the most useful contribution and have their own issue template.

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT — see [LICENSE](LICENSE).
