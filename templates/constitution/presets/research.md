# Preset: research literature

Vocabulary for a knowledge base over papers, reports, standards, or any corpus of documents
that make claims and cite each other. Composes with `base.md`.

## Configuration

```yaml
page_types:
  - source # one per document: what it is, who produced it, what it covers
  - concept # an idea the literature uses, defined once and referenced widely
  - finding # a specific claim, with the evidence behind it
  - method # a technique or procedure the literature relies on
  - contradiction # a page devoted to a disagreement between sources
  - synthesis # a page that reads across several sources

link_fields:
  - cites # a source this draws on
  - cited_by
  - supports # evidence that strengthens a finding
  - contradicts # evidence that conflicts with it
  - supersedes # a later result that replaces an earlier one
  - superseded_by
  - related
  - discussed_in

provenance:
  format: "{source} @ {rev} · {path}#L{start}-L{end}"
```

## `contradiction` is a page type here, and that is deliberate

In most corpora a disagreement is a paragraph inside a page. In a literature corpus it is
often the most valuable thing you can write, and it deserves to be findable on its own.

```markdown
---
type: contradiction
contradicts: [[findings/permafrost-feedback-strength]]
---

# Disagreement on permafrost feedback strength

Two assessments give values differing by a factor of three.

- Source A: 0.09 W m-2 per degree, from a model ensemble excluding abrupt thaw.[^a]
- Source B: 0.27 W m-2 per degree, including abrupt thaw processes.[^b]

The gap is not a measurement error: the assessments are modelling different processes. No
resolution is attempted here.
```

Note what the page does *not* do. It does not decide. It names the disagreement, cites both
sides, and — where it can be established from the sources — says what the disagreement is
about. "The gap is not a measurement error" is itself a claim and needs its own citation if
it is not evident from the two sources.

## Superseded does not mean deleted

When a later result replaces an earlier one, both keep their pages, linked with
`supersedes` / `superseded_by`. The earlier page stays because the literature still cites it,
and a reader arriving from an old reference needs to land somewhere that tells them it was
superseded.

Deleting the old page makes the knowledge base *less* accurate about the state of the field.

## Revisions for documents that do not version themselves

Papers and reports rarely carry commit SHAs. With an `fs` source, the revision is a hash of
modification times — which means a change that preserves mtime is invisible, and a revision
does not survive a process restart.

Both consequences are honest rather than hidden:

- Re-verification is cheap for a static corpus, so re-verify when in doubt.
- `accreta drift` reporting **unresolvable** for a revision from a previous run is expected
  behaviour, not a bug. It is the system saying "I cannot tell", which is the correct answer
  and a different one from "nothing changed".

For a corpus that is genuinely versioned — a standards repository, a preprint server with
revisions — use the git adapter and get real revisions.

## Distinguish what a source claims from what is true

A `finding` page records what a source found, attributed. It does not assert the finding as
fact on the knowledge base's own authority.

> Source A reports a 0.09 W m-2 per degree feedback.[^a]

not

> The feedback is 0.09 W m-2 per degree.[^a]

The difference is invisible when sources agree and decisive when they do not. Writing the
second form is how a knowledge base ends up silently choosing a winner while appearing merely
to be describing.
