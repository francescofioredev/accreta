# CLAUDE.md — accreta

You are working on **accreta**: a knowledge base that an AI agent writes and maintains, with
provenance back to the sources and drift detection when those sources change.

This file is the operating manual for working *on accreta itself*. It is not the constitution
that accreta generates for its users — that lives in `templates/constitution/` and is a
product artifact.

---

## 1. What this project is

Most systems that give an agent knowledge of a large corpus use RAG: embed everything,
retrieve chunks per query, rebuild context every time. accreta takes the other path, from
[Karpathy's LLM wiki pattern](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f):
the agent **compiles** knowledge into interlinked markdown once and then keeps it current.

Three properties follow, and they are the whole point:

1. **Provenance** — every non-trivial claim cites source, path, line range, revision.
2. **Drift detection** — each page records the revision it was verified against, so when a
   source moves the system names the pages now in doubt.
3. **Refusal to over-synthesize** — when sources disagree, record the contradiction; never
   silently pick a winner.

Anything that erodes one of these three is a regression, even when it makes the tool more
convenient.

## 2. Origin, and what it means for the code

accreta is extracted from a system that documented a 17-repository backend and runs in
production. Much of the code arrives already proven. Two consequences:

- **Comments that explain a failure are load-bearing.** The original carries remarks like
  "a read-only connection cannot create the `-shm` file a WAL database needs". Each encodes
  an incident. Port them; do not tidy them away.
- **Generalizing is the work.** The original assumed git repositories and code-shaped page
  types. Removing those assumptions *without losing the mechanics* is the actual task. When
  in doubt, keep the mechanism and lift the assumption.

## 3. Architecture

```
sources (git · fs · …)  ──►  knowledge base (markdown)  ──►  index (SQLite)
   SourceAdapter                frontmatter + wikilinks        pages · fts5 · links
        │                                                             │
        └──────── drift: what did this change invalidate? ─────────────┘
                                                                      ▼
                                                            MCP server · CLI
```

- `packages/core` — parsing, link graph, indexer, search. Knows nothing about git.
- `packages/adapters/*` — one directory per source type.
- `packages/mcp-server` — the agent-facing surface.
- `packages/cli` — the human-facing surface.
- `templates/` — constitution and scaffold shipped to users.
- `skills/accreta-setup` — the guided-configuration skill.

**The rule that matters**: the core must never branch on which adapter it is talking to. An
`if (adapter === 'fs')` in `packages/core` means the abstraction is wrong. Fix the
abstraction, not the call site.

## 4. Conventions

- **English everywhere.** Code, comments, docs, commits, issues, PRs.
- **`accreta.config.yaml` owns the vocabulary.** Page types and link fields are never
  hardcoded. The code-oriented types ship as a preset, not as the default.
- **Env prefix is `ACCRETA_`.**
- **No absolute paths, ever** — not in code, docs, skills, or examples. This runs on other
  people's machines.
- **A test for every bug fix**, failing before and passing after.
- **No claim without a measurement.** "Faster" and "more accurate" require numbers.
- **ADR for architectural decisions**, in `docs/adr/NNNN-title.md`, recording the rejected
  alternatives too.

## 5. Working rhythm

The roadmap is six phases, one epic each, tracked on the
[project board](https://github.com/users/francescofioredev/projects/1):

| Phase | Epic | |
|---|---|---|
| 1 | Core: indexer, frontmatter, link graph | [#1](https://github.com/francescofioredev/accreta/issues/1) |
| 2 | Source adapters: the abstraction | [#2](https://github.com/francescofioredev/accreta/issues/2) |
| 3 | MCP server and CLI | [#3](https://github.com/francescofioredev/accreta/issues/3) |
| 4 | Hybrid search | [#4](https://github.com/francescofioredev/accreta/issues/4) |
| 5 | Constitution templates and setup skill | [#5](https://github.com/francescofioredev/accreta/issues/5) |
| 6 | Demo knowledge base, docs, v0.1.0 | [#6](https://github.com/francescofioredev/accreta/issues/6) |

Open a task issue under the relevant epic, branch, PR, squash merge. `main` is protected and
takes no direct pushes; force pushes and deletion are blocked.

A code-owner review is required, but GitHub does not let anyone approve their own pull
request — so with one maintainer that rule would block every change. Until there is a second
reviewer, the maintainer merges with `gh pr merge --admin`. The scope of that exception is
written down in `CONTRIBUTING.md`; keep it there rather than letting it become folklore.

## 6. This repository is public

It has been public since the first commit, and its history cannot be retracted.

- **Never commit a secret.** Not even briefly, not even in a branch. Deleting it later does
  not remove it from the history.
- **Never carry over anything from the private system this was extracted from.** No client
  or product names, no internal URLs, no infrastructure details. Keep the terms to scan for
  in `.scratch/leak-terms.txt` — untracked, so the list itself never becomes the leak — and
  check before every push:
  ```bash
  git diff --cached --name-only | xargs grep -rilf .scratch/leak-terms.txt
  ```
  This is not theoretical: the first draft of this very file failed that check.
- Commit messages are public writing. Explain *why*; the diff shows *what*.

## 7. What not to do

- **Do not weaken provenance for convenience.** A page without citations is a bug in the
  method, not a shortcut.
- **Do not let the core learn about git.** That coupling is exactly what this project exists
  to remove.
- **Do not write a skill for a workflow that does not exist yet.** Skills are distilled from
  lived procedures; written ahead of time they document fiction.
- **Do not hardcode page types.** Every time it feels easier, it is the same mistake being
  reintroduced.
- **Do not claim an improvement without measuring it.** Especially for search.
