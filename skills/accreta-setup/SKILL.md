---
name: accreta-setup
description: Set up an accreta knowledge base over a corpus — pick a preset, write the config and a source declaration, generate the constitution, wire up MCP, and verify the first ingest. Use when someone wants an agent-maintained knowledge base with provenance and drift detection over a codebase, a document collection, or a research corpus; when a directory contains accreta.config.yaml and something is wrong with it; or when asked to add a source to an existing knowledge base.
---

# Setting up an accreta knowledge base

This procedure is distilled from doing it, not from planning it. The order below is the order
that worked; the warnings are things that actually went wrong.

## Before anything: look at the corpus

The single decision that shapes everything else is which preset fits, and it is decided by
what the sources *are*, not by what the user says they want.

| Corpus | Preset | Tell |
|---|---|---|
| source code, one or more repositories | `codebase` | files with extensions, a git history, imports between modules |
| papers, reports, standards, specs | `research` | prose documents that cite each other, no call graph |
| anything else | *(none)* | the default vocabulary — `note`, `source`, `concept`, `decision`, `synthesis` |

Do not guess from a repository name. Read a few files. A repository full of markdown
specifications is a `research` corpus that happens to live in git.

If the corpus is genuinely mixed, prefer the default vocabulary over forcing one preset —
page types are configuration and can be extended later, but a wrong preset produces pages
described in terms that do not fit and are tedious to rename.

## 1. Initialize

```bash
accreta init --preset research    # or --preset codebase, or no flag
```

This writes `accreta.config.yaml`, `knowledge/`, `sources/`, and `AGENTS.md` — the
constitution the maintaining agent follows.

**`init` will not overwrite an existing `AGENTS.md`.** If the project already has one, `init`
says so and writes nothing. Compose the constitution separately and merge it by hand; do not
delete theirs.

## 2. Declare the sources

One YAML file per source in `sources/`. Delete the generated `example.yaml` — leaving it
produces confusing drift output about a source that does not exist.

```yaml
# sources/ipcc.yaml
id: ipcc
type: fs
root: sources/ipcc
extensions: [".md", ".txt"]
```

```yaml
# sources/billing-service.yaml
id: billing-service
type: git
root: ../billing-service
```

Choosing the adapter:

- **`git`** when the corpus is a repository. Revisions are commit SHAs, so drift detection
  can say exactly which files changed since a page was verified.
- **`fs`** for a directory of documents. Revisions are a hash of modification times.

Two `fs` consequences to state plainly, because they surprise people:

- A change that preserves mtime is invisible.
- **A revision does not survive a process restart.** `accreta drift` will report
  `unresolvable` for pages verified in an earlier run. That is the system saying *I cannot
  tell*, which is correct and is not the same as *nothing changed*. Do not treat it as a bug.

`id` matters: it appears in every citation and in each page's `source` field. Pick the name
you want to read a thousand times.

## 3. Build the knowledge base

This is the part no tool does for you. Read the sources and write pages, following the
constitution in `AGENTS.md`.

The rules worth repeating here, because they are the ones most often skipped under time
pressure:

- Every non-trivial claim cites source, path, lines, **and revision**. The revision is the
  part people drop and the part drift detection needs.
- Never duplicate a source. Cite it.
- When sources disagree, record the disagreement rather than picking a winner.
- A concept needs at least two real points of contact before it earns a page.
- **Declare `aliases`.** Search consults them alongside title and body, so a page whose
  alias is the only place a name appears is reachable by that name and unreachable without it.

## 4. Index and check

```bash
accreta reindex
accreta lint
```

`lint` exits non-zero when it finds something, so it belongs in CI.

Expect findings on a first pass, and read them rather than silencing them:

- **dangling-link** — a link to a page that does not exist. Either the link is wrong, or the
  page is owed real content. **Do not create a stub to make the warning go away**; a stub is
  a link target that promises more than it delivers.
- **missing-provenance** — no `canonical_source`. The page cites nothing.
- **unverified-page** — no `last_verified_revision`. The page can never drift, because
  nothing knows what it was checked against.
- **unparseable-frontmatter** — the frontmatter block would not load, so every field in it
  was discarded. Fix this one **first**: it is the cause of any `missing-provenance`,
  `unverified-page` or `unknown-page-type` finding reported against the same page, and
  those will clear on their own once the block parses. The detail names the line.

Then:

```bash
accreta drift
```

## 5. Wire up MCP

`.mcp.json`, in whichever project the agent will work from:

```json
{
  "mcpServers": {
    "accreta": {
      "command": "bun",
      "args": ["run", "node_modules/@accreta/mcp-server/src/main.ts"],
      "env": { "ACCRETA_ROOT": "../path/to/knowledge-base" }
    }
  }
}
```

`ACCRETA_ROOT` is the whole point: the agent queries a knowledge base it has no filesystem
access to.

Writes are off by default. `update_verified_revision` is not registered at all unless
`ACCRETA_ALLOW_WRITES=1` is set in that `env` block. **Leave it off** unless the agent is
meant to re-verify pages, and understand what it does first: it rewrites the provenance the
whole system rests on.

Understand who it extends trust to, as well. Pages are untrusted input to the model — an agent
reads them into its context, and an instruction written inside one arrives there the same way
the page's real content does, through the title and `aliases` as much as the body. So
`ACCRETA_ALLOW_WRITES=1` means any page in the corpus can direct a write. The dry-run-and-token
handshake confirms the edit but does not decide whether it should happen, and an agent following
an instruction it read will complete the handshake on its way to the write.

## 6. Verify, from outside

Do not declare it working because `reindex` printed a page count. Query it the way the agent
will:

```bash
accreta search "<a term from a page you wrote>"
accreta canonical "<an alias you declared>"
accreta consumers "<a page other pages link to>"
```

**`search` searches the pages, not the sources.** A term that appears only in a source
document and in no page returns nothing, and that is correct — the knowledge base indexes
what was written about the sources, not the sources themselves.

`canonical` against a declared alias is the best single check: it exercises frontmatter
parsing, alias indexing, and retrieval together in one command.

If `consumers` returns less than expected, run `accreta lint` and look for broken links.
**Under-reporting is this system's characteristic silent failure**: the pages render, the
links look right on GitHub, and impact analysis quietly returns a short answer.

## Adding a source later

Write the new `sources/*.yaml`, run `accreta reindex`, then `accreta drift`. Nothing else
changes: pages already written keep their `source` field, and the new source starts with no
pages verified against it.

## When something is wrong

| Symptom | Cause |
|---|---|
| `No accreta.config.yaml found` | not inside the knowledge base; `cd` there or set `ACCRETA_ROOT` |
| `No index at …` | run `accreta reindex` |
| everything reports `unresolvable` | expected for `fs` after a restart — re-verify, or use `git` |
| a page is missing from search | check `accreta lint`; a page whose frontmatter will not parse still indexes but loses its fields — `unparseable-frontmatter` names the line |
| `consumers` returns fewer pages than expected | broken links — `accreta lint` names them |
