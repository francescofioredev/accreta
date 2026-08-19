# ADR-0003: Page types and link fields are configuration, not code

Status: accepted
Date: 2026-08-08

## Context

The system this was extracted from hardcoded its page types. `module`, `api`, `usecase`,
`endpoint` — sensible names for a knowledge base about a backend, and meaningless for one
about anything else.

They were hardcoded in three places: an `inferType()` map in the indexer, a `PAGE_TYPES`
enum in the search tool, and a `LINK_FIELDS` constant in the parser. Three copies of one
fact drift apart, which is what they had begun to do.

## Decision

`accreta.config.yaml` owns the vocabulary:

```yaml
page_types: [note, source, concept, decision, synthesis]
link_fields: [related, supersedes, superseded_by, discussed_in]
```

Nothing in the code enumerates page types. `extractLinks()` takes the config and reads the
fields it names; the indexer records whatever `type` a page declares; `lint` compares against
the configured list and reports what falls outside it.

The code-oriented vocabulary ships as `templates/constitution/presets/codebase.md` — a
preset, precisely because it is not universal.

**The schema follows the same rule.** The original promoted `symbol`, `route`, `method`,
`operation_type`, `stability`, `severity` and `issue_id` to SQL columns. Those are the same
mistake one layer down: for a knowledge base about climate science they are columns that are
always NULL. Only vocabulary-independent fields get columns — `path`, `type`, `title`,
`source`, `canonical_source`, `last_verified_revision` — and everything else lives in
`frontmatter_json`.

## The one exception, and why it is one

`aliases` is indexed as an FTS column rather than left in `frontmatter_json`.

This looks like a violation and is not: `aliases` is part of the *page schema*, like `type`
and `canonical_source`, rather than part of the domain vocabulary. Every knowledge base has
concepts known by more than one name. None of them needs `route`.

The distinction is worth stating because it is the boundary that will be argued over: a field
belongs in the schema if every corpus has it, and in configuration if only some do.

Measured consequence: with aliases outside the index, a page reachable only by its declared
alias is not reachable at all — the query returns nothing rather than ranking it lower. See
ADR-0001, which also records how small the sample behind the accompanying percentages is.

## Alternatives rejected

**A fixed superset of every plausible page type.** Ship `module`, `api`, `paper`, `dataset`,
`finding` and let each knowledge base ignore what it does not use. Rejected: the list is
never complete, additions require a release, and every knowledge base carries vocabulary
belonging to someone else's domain.

**Types validated at write time, rejecting unknown values.** Rejected because the failure
mode is wrong. A page with an unrecognized type is still a page and should still be indexed
and findable; `lint` reports it as a finding. Refusing to index it hides the page most likely
to need attention.

**No page types at all — everything is a page.** Simpler, and loses the filtering that makes
`search_pages(types: ["decision"])` useful. Types earn their place because callers ask
type-shaped questions.

## Consequences

- Adding a page type is a configuration edit. No release, no code change.
- The core never enumerates types, so it cannot drift from what a knowledge base declares.
- Two things must move together — the vocabulary in `accreta.config.yaml` and the vocabulary
  in the constitution the agent follows. `accreta init --preset` writes both from one choice,
  which is why the preset selects the config as well as the constitution.
- `lint` is the only place that compares a page's type against the configured list, so there
  is exactly one definition of "unknown type".
