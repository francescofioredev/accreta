# ADR-0011: A citation points at a locator, and only the source knows what one means

Status: accepted
Date: 2026-09-08

## Context

ADR-0002 claims a source is four methods and the core knows nothing else about it. Three
places contradicted that, and all three said the same thing: a document is a file, and a
place inside it is a line.

- `parseCitation` matched `source:path#Lstart[-Lend]` with a fixed regex, so a pointer into a
  block-addressed document could not parse at all.
- `lintCitations` checked a range by reading the source and taking `text.split("\n").length`.
  Line semantics inside `packages/core`, which is `if (adapter === "fs")` with the branch
  hidden in a method call.
- `SourceAdapter.read()` returned a document's text — and had exactly one caller, that
  newline count. The core has never consumed a source's content for any other purpose, so the
  interface promised a capability the system did not use and could not always provide.

The corpora that made this urgent are the ones a person reaches through a connector rather
than a checkout: a wiki page, a mail thread, a record in a tool. They have revisions and they
have addressable parts, which is everything drift detection needs — but the parts have ids,
not line numbers, and the content is not ours to fetch.

## Decision

**`canonical_source` is `source:path[#locator]`, and the locator is opaque above the
adapter.** `L142-L158` for a file, something like `block-a1b2c3` for a page. `ParsedCitation`
carries the string; nothing in the core interprets it.

**`locate()` replaces `read()` on the interface.**

```ts
locate(path: string, locator?: string): Promise<LocationVerdict>;

type LocationVerdict =
  | { verdict: "found" }
  | { verdict: "missing"; part: "path" | "locator"; detail: string }
  | { verdict: "unknown"; detail: string };
```

What is left of the interface states the architecture rather than merely permitting it:
**accreta asks a source about revisions and locations, and never reads it.** That was already
true in the code; the interface said otherwise, and the gap was where the line assumption
lived.

### Three verdicts, because two would force a lie

A source accreta cannot reach can check nothing. Answering `missing` would report every
citation into it as broken; answering `found` would claim a check that never happened. So
`unknown` is a first-class answer, and `lintCitations` counts it into
`LintReport.citationsUnchecked` rather than emitting findings — "I did not look" must not
render as "I found something", which is the rule that file already applied to unconfigured
sources.

This is ADR-0002's distinction between "nothing changed" and "I cannot tell", one question
down. It is the same failure and it deserved the same shape.

### The grammar owns line ranges; the adapter owns existence

`parseLineLocator()` stays in the core, beside `resolveInside()` and for the reason that
comment already gives: two file-backed sources that read `L142-L158` differently would make a
citation mean different things depending on which source it happened to name. The core
offering a parser for a convention is not the core assuming every source follows it.

A consequence worth stating because it changes an existing behaviour: the range validity
checks (`L0`, `L9-L2`) moved out of `parseCitation` and into that parser, so a descending
range is now `citation-locator-missing` rather than `unparseable-citation`. That is the more
accurate of the two — the pointer is well formed and names a real document; what is wrong is
where inside it points, and only the source can say so.

## Alternatives rejected

**Keep `read()` and add `locate()` alongside it.** The smaller diff. Rejected: a source that
cannot hand over content would carry a method it can only throw from, and an interface with a
method some implementations decline is the capability flag ADR-0002 rejected wearing
different clothes. It also leaves the newline count in the core, which is the actual defect.

**Let non-file sources cite whole documents, with no locator.** No grammar change at all.
Rejected: provenance gets coarser exactly where it needs to be finer — a long wiki page cited
as a whole says little more than naming the wiki — and the next source type asks the same
question again, at which point the grammar changes anyway with citations already written
against the old answer.

**Address non-file sources by line, over a deterministic rendering of the document.** Keeps
one locator syntax everywhere and reads well. Rejected: the rendering becomes a public
contract. Any change to how a page is flattened silently invalidates every citation already
written against it, and the only signal is lint going red across the corpus at once, with
nothing to distinguish it from a corpus that genuinely rotted.

**Let `provenance.format` describe `canonical_source` too**, so a knowledge base has one
citation format instead of two. Rejected for the reason `parseCitation` was written separately
in the first place: the machine-readable pointer must mean the same thing in every knowledge
base, or a check cannot resolve it without first knowing how that knowledge base likes its
citations to read.

**Model the locator as a union in the core** — a line range or an opaque id. Rejected: the
core would be enumerating the kinds of address a source may have, which is the same mistake as
enumerating page types, and the union grows by one every time somebody writes an adapter.

**Duplicate the line-locator parser into `fs` and `git`** rather than sharing it from the core,
to keep every trace of line vocabulary out of `packages/core`. Rejected: the shared thing here
is the citation *grammar*, which the core already owns, and two copies of a regex drift in the
direction of one of them getting a fix.

## Consequences

- `{start}` and `{end}` are no longer substituted. A `provenance.format` still carrying them
  renders them literally. `formatCitation` has no production callers today — the agent writes
  footnotes by hand, following the constitution — so the migration cost is config templates
  and documentation, and it would not have been this cheap later.
- `LineRange` leaves the core's public surface. Adapters that want a tuple parse one.
- `SourceAdapter.read()` is gone. Nothing in accreta reads a source's content, and a reviewer
  can now check that claim by reading the interface.
- `packages/adapters/test/interchangeable.test.ts` gains the escape case in its new form: a
  path that climbs out of the declared scope must return `missing`, never `found`. The
  guarantee no longer depends on an error message.
- The `fs` and `git` adapters each implement roughly twenty lines of "read the file, count
  the lines, compare" that the other also implements. Accepted rather than hidden: the
  conformance suite runs both, so a fix applied to one and not the other shows up as a
  failure.
