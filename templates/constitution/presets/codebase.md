# Preset: source code

Vocabulary for a knowledge base over one or more code repositories. Composes with
`base.md`, which carries the method; this file adds only what is specific to code.

## Configuration

```yaml
page_types:
  - repository # one per codebase: what it is, how it is laid out, how it is run
  - module # a coherent unit of code — package, service, subsystem
  - api # an endpoint or public interface
  - usecase # a flow through the system that accomplishes something
  - concept # a domain idea the code assumes but does not define in one place
  - decision # an architectural decision and its rationale
  - integration # a boundary with something outside this codebase
  - synthesis # a page that reads across several of the above

link_fields:
  - consumers # what calls this page's subject
  - consumes # what this page's subject calls; the inverse of `consumers`; declare it on either page, `consumers` shows both
  - delegates_to # what this page's subject hands work to
  - implements # the interface or contract this page's subject realizes
  - supersedes
  - superseded_by
  - amends # the earlier decision this page's decision changes but does not replace
  - amended_by # a later decision that changes this one
  - related
  - discussed_in

provenance:
  format: "{source} @ {rev} · {path}#{locator}"
```

## What deserves a page

Code is large and mostly uninteresting. The judgment that matters is what to leave out.

**Worth a page:** a module whose responsibility is not obvious from its name; an API other
systems depend on; a use case that crosses several modules; a domain concept the code assumes
everywhere and defines nowhere; a decision whose rationale would otherwise be lost.

**Not worth a page:** a function whose signature says everything; a data class; anything
whose page would restate the code in prose. If the page would be a worse version of reading
the source, do not write it.

The test is whether the page answers a question the code does not answer easily. "What calls
this and why" is such a question. "What does this function do" usually is not.

## Line ranges are the point

For code, a citation without a line range is nearly useless — a file path points at hundreds
of lines. Cite the definition, not the file:

```markdown
Requests are rejected before authentication when the tenant header is absent.[^guard]

[^guard]: billing-service @ 3f9a2b1c7d4e8f05a6b2c9d1e3f7a8b4c6d0e2f9 · src/middleware/tenant.ts#L34-L51
```

## Revisions are commit SHAs

With a git source, `last_verified_revision` is the commit the page was checked against, as the
full SHA `cite` prints.
`accreta drift` then reports exactly which files changed since — and a page whose module was
untouched by a hundred commits is not stale.

**Beware the rename.** A moved or renamed file shows up as a change to both paths. The page
is usually still correct and the citation is not; fix the path rather than re-verifying the
whole page.

## Decision records

A decision record carries its status in frontmatter, as the record states it:
`status: Accepted`, `Proposed`, `Deprecated`. Nothing indexes it yet, so a search cannot
filter on it; state it in the body too, which search does index. A status that names another
record, such as "Superseded by 0012", still needs the matching link field: `status` is not in
the link graph.

Decisions amend each other far more often than they replace each other. When a later record
changes an earlier one that still holds in part, link them with `amends` / `amended_by`, on
both pages; lint checks only the supersession pair, so nothing catches a missing half.
Use `supersedes` / `superseded_by` only when the earlier decision no longer holds at all.

## Concepts are where the value is

The pages that repay the effort are the concept pages: the ideas the code assumes and never
states. "What we mean by an account", "why every request carries a tenant", "what
reconciliation means here".

Those are exactly what a new engineer — or an agent — cannot get from reading the code,
because they live in the gaps between modules. A concept page needs at least two real points
of contact in the code, per the base rule against speculative pages; for a concept, the
natural pair is the place that defines it and a place that relies on it.
