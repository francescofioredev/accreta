# Writing a source adapter

A source is anything that can answer three questions: what revision are you at, what changed
since a given revision, and how do I cite a location inside you. Adapters are the natural
extension point of this project — if accreta cannot read your corpus, this is the file you
need.

## The interface

```ts
interface SourceAdapter {
  readonly id: string;
  revision(): Promise<string>;
  changedSince(revision: string): Promise<string[]>;
  read(path: string): Promise<string>;
  citation(path: string, lines?: LineRange): string;
  pinRevision(revision: string): void;
}
```

Five methods. `packages/core` imports no adapter and never branches on which one it holds —
if you find yourself wanting it to, the interface is missing something and the fix is to
extend the interface. See [ADR-0002](adr/0002-source-adapter-interface.md).

## `revision()`

Any opaque string that changes exactly when the source changes. Git returns a commit SHA; the
filesystem adapter returns a hash of paths and modification times; an HTTP source might
return an ETag.

The core never parses it. It compares it for equality and hands it back to `changedSince()`.

**Do not make this expensive.** It is called on every drift check. The `fs` adapter hashes
modification times rather than contents precisely because hashing contents would turn a stat
walk into a full read of the corpus — a trade-off that is documented in the adapter rather
than hidden.

## `changedSince()` — the method that matters

Return the paths that changed between that revision and now.

**It must be able to say "I cannot tell."** Throw `UnknownRevisionError` when the revision is
one you cannot place:

```ts
async changedSince(revision: string): Promise<string[]> {
  if (!(await this.knows(revision))) {
    throw new UnknownRevisionError(this.id, revision);
  }
  return this.diff(revision);
}
```

Returning `[]` instead means *nothing changed*, and drift detection will render every page
verified against that revision as current. It has no way to detect that you guessed. This is
the single most important thing to get right in an adapter, and the easiest to get wrong,
because an empty array is what a stub returns.

Real cases: rewritten history, a shallow clone that lacks the commit, a revision from a
different source, and — for `fs` — any revision from a previous process, since a hash cannot
be inverted.

**Scope the source to what it actually contains.** If several sources live inside one
repository or one tree, a source that reports the whole tree's revision drifts every page
whenever anything changes, however unrelated. `GitSource` takes a `paths` option for exactly
this, and computes its revision as the last commit that touched those paths rather than HEAD.
A drift report full of false positives is one people learn to ignore, which costs more than
having no report.

Returning *every* path is a valid answer for a source that cannot compute a difference. It is
less useful, not incorrect.

## `read()` and `citation()`

`read()` takes a path relative to the source root.

`citation()` renders the configured provenance format. Use `formatCitation()` from the core
rather than building the string yourself — it drops the `#L{start}-L{end}` decoration when a
source has no line numbers, instead of emitting `undefined`.

## `pinRevision()`

A citation must name **the revision the claim was verified against**, not whatever the source
is at when the page is rendered later. That is the difference between provenance and a guess.
Only the caller knows which revision a claim was checked against, so `pinRevision()` is how
it says so, and `citation()` renders whatever was last pinned.

Until something pins you, render `UNPINNED_REVISION` from the core. Do not substitute your
source's current revision, and do not invent a plausible-looking placeholder of your own:
`git` used to fall back to `"HEAD"`, which reads as a real revision and so claims something
the source cannot support. `fs` shipped a `citation()` that named no revision at all and
still passed its adapter tests, because the shared suite checked only the path and line
tail. Both are the same mistake — a citation that satisfies the shape without keeping the
promise.

## Registration

Adapters register by type name, in the surface rather than the core:

```ts
new SourceRegistry().register("http", (d) => new HttpSource({
  id: d.id,
  url: String(d.options.url),
  citationFormat: config.provenanceFormat,
}));
```

Everything besides `id` and `type` reaches you untouched in `d.options`. The core does not
validate them — validating them would require knowing what your adapter needs.

Users then declare a source in `sources/*.yaml`:

```yaml
id: rfc-editor
type: http
url: https://example.org/rfcs/
```

## Testing it

Write the adapter's own tests, then add it to
[`packages/adapters/test/interchangeable.test.ts`](../packages/adapters/test/interchangeable.test.ts).

That file runs **one set of assertions against every adapter** — deliberately written once
rather than per adapter. If your adapter needs different expectations from `fs` and `git`,
the abstraction is leaking and that is worth knowing before the code merges.

You provide a fixture: a source at an initial revision, and a way to move it forward. The
suite pins your adapter, moves the source, and asserts the citation still names the pinned
revision — so the property above is checked for you rather than left to your own tests.

## Before you write one

Open an adapter proposal issue first. The template asks the three questions any new source
type has to answer, and they are the ones that determine whether the adapter is possible at
all:

1. What is a revision for this source?
2. How does it report what changed — and how does it tell you it cannot?
3. What does a citation into it look like?

If the first two have no good answer, the source cannot support drift detection, and drift
detection is most of the point.
