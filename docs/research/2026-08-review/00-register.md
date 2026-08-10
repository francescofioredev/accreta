# Finding register

Thirty-one findings survived verification. The last seven came from a later review of adversarial content, added at the maintainer's request after the first six lenses had reported. Ordered by severity, then by how certain the
evidence is.

Each row went through the same procedure: six reviewers worked independently from one
disciplinary lens each, then an adversarial verifier deduplicated them, opened every cited
`file:line`, checked every cited paper against its source, and rejected what did not hold.
Findings that arrived three times as three different severities were merged into one.

**Route** says where a finding goes, and the distinction is load-bearing:

- **ADR** — an architectural decision that can be taken now, on the evidence in hand, with
  the rejected alternative nameable.
- **ISSUE** — a real defect with a known fix and no architectural content.
- **MEASUREMENT** — plausible, but the decision cannot be taken until a specific number
  exists. The number is named in the finding. This project's rule is that no claim ships
  without a measurement, so an ADR written on an unmeasured finding would violate its own
  standard.

## The register

| ID    | Finding                                                                                                     | Severity | Evidence            | Route       |
| ----- | ----------------------------------------------------------------------------------------------------------- | -------- | ------------------- | ----------- |
| RT-01 | A long-lived MCP server hard-fails after any reindex, and no reopen path exists                             | high     | MEASURED            | ISSUE [#41]|
| RT-02 | A recorded contradiction never reaches the agent through the default read path                              | high     | MEASURED            | ADR         |
| RT-03 | `check_drift` copies `changedPaths` into every stale page — a P×C response that overruns any context window | high     | MEASURED ×3         | ISSUE [#42]|
| RT-04 | Citation paths and line ranges are never validated; a fabricated pointer passes every check                 | high     | REASONED            | ISSUE [#45]|
| RT-05 | Four read tools are unbounded; `lint_knowledge_base` cannot be asked for less                               | high     | MEASURED            | ISSUE [#47]|
| RT-06 | Two concurrent rebuilds race on a fixed staging filename; the loser's index is discarded                    | high     | MEASURED            | ISSUE [#44]|
| RT-07 | Read-stage cost steps ~3× at ~20,000 files. ADR-0004's _scope_ is wrong; its 43ms is not                    | high     | MEASURED ×3         | ADR         |
| RT-08 | `supersedes` / `superseded_by` ship in the vocabulary and the constitution, and nothing interprets them     | high     | MEASURED            | ADR         |
| RT-09 | ADR-0001's alias and paraphrase percentages ship to users stripped of their intervals                       | high     | MEASURED + CITED    | ISSUE [#48]|
| RT-10 | Verification records that a check happened, never who made it or how                                        | high     | CITED + MEASURED    | MEASUREMENT |
| RT-11 | `unverified-page` invites exactly the fix the constitution calls maximally damaging                         | high     | REASONED            | MEASUREMENT |
| RT-12 | `FsSource.citation()` renders `rev="unknown"` forever, and the tests cannot catch it                        | high     | MEASURED            | ISSUE [#43]|
| RT-13 | A depth-carrying recursive CTE defeats SQLite's cycle protection — a trap, not yet a bug                    | medium   | MEASURED ×2 + CITED | ISSUE       |
| RT-14 | `search_pages`'s description omits `aliases`, contradicting the schema                                      | medium   | MEASURED            | ISSUE       |
| RT-15 | A mutually contradictory supersession state passes lint clean                                               | medium   | MEASURED ×2         | ISSUE       |
| RT-16 | `findCanonical`'s alias branch is a full scan, and neither it nor lint has a `LIMIT`                        | medium   | MEASURED            | ISSUE       |
| RT-17 | mtime revisions cause false-positive drift on rsync and `cp -R` (diagnosis kept, proposal withdrawn)        | medium   | MEASURED            | MEASUREMENT |
| RT-18 | No tool declares `outputSchema`; drift's three-way distinction arrives as prose                             | medium   | MEASURED + CITED    | MEASUREMENT |
| RT-19 | ADR-0001's reopen triggers cannot be evaluated; trigger 2 is unfalsifiable as written                       | medium   | REASONED            | ISSUE       |
| RT-20 | `.gitignore`'s "~150ms" predates all code and never measured anything                                       | low      | MEASURED            | ISSUE       |
| RT-21 | A frontmatter merge conflict on `last_verified_revision` has no resolution procedure                        | medium   | REASONED            | MEASUREMENT |
| RT-22 | Obsolescence is structurally invisible to per-source drift                                                  | medium   | MEASURED            | ADR         |
| RT-23 | `get_page`'s flat 29.8KB is a benchmark artifact — do not act on it                                         | medium   | MEASURED            | ISSUE       |
| RT-24 | No graph database is needed; SQLite serves every plausible traversal                                        | low      | MEASURED            | ADR         |
| RT-25 | The confirm-token is correct for its threat model and structurally cannot stop an injected instruction      | high     | MEASURED            | ADR         |
| RT-26 | Attacker-controlled text reaches the model through five channels, not just the page body                    | high     | MEASURED            | ISSUE [#49]|
| RT-27 | A wikilink inside a double-quoted frontmatter value discards the entire frontmatter                         | high     | MEASURED ×2         | ISSUE [#46]|
| RT-28 | `ACCRETA_ALLOW_WRITES` is process-wide and cannot express _for whom_ on a shared deployment                 | high     | REASONED            | MEASUREMENT |
| RT-29 | Nothing in the shipped guidance tells the operator that pages are untrusted input to the model              | high     | MEASURED            | ISSUE [#50]|
| RT-30 | The parser withstood 15 adversarial inputs; the resource guard belongs to `yaml`, not to accreta            | low      | MEASURED            | ISSUE       |
| RT-31 | The path boundary holds — and symlink containment is accidental, undocumented, and untested                 | low      | MEASURED            | ISSUE       |

## The five findings that decide the most

**RT-07 — where the filesystem stops making sense.** The answer to that question is a
number, and it is **15,000–20,000 pages**. What binds is not memory, not git, not the
index: it is rebuild latency inside the agent's verification loop, because
`update_verified_revision` writes markdown and tells the caller to reindex. Per-page cost
bottoms out at 0.090ms at 15,000 pages and rises from there; between 15,000 and 20,000 the
build grows 1.95× for 1.33× the pages.

The cause was isolated rather than guessed. It is `readFileSync`, not SQLite, not garbage
collection, not directory-entry limits — all three were eliminated by measurement. Per-file
read cost steps from ~15µs to ~42µs as the tree's metadata stops fitting in cache, and the
read stage goes from 42% to 75% of the rebuild between 10,000 and 30,000 files. That is a
**constant-factor step, not unbounded growth**, which is what makes it fixable: the reads
are syscall-bound, so they parallelise, and parallelising them leaves the single
transaction — the property ADR-0004 exists to protect — completely intact.

ADR-0004 said "at a hundred thousand this decision would need revisiting". The measured
knee is an order of magnitude earlier.

**RT-02 — the interface picks the winner the author was forbidden to pick.** The
constitution's third rule binds the author: when sources disagree, record the
disagreement, never choose. A knowledge base can obey it perfectly and still fail, because
`search_pages` and `get_page` return a superseded page with no signal that it is contested,
and `find_canonical` returns it under a description promising the page that _authoritatively_
defines the term. The contradiction is on disk. The default read path never consults it.
Rule three is enforced one level above where the failure happens.

**RT-08 and RT-22 — obsolescence.** `supersedes` and `superseded_by` are in the default
vocabulary, in the presets, and in the constitution, which tells users that "a reader
arriving from an old reference needs to land somewhere that tells them it was superseded".
Nothing in the core interprets them. They are ordinary links whose names merely sound
meaningful.

Underneath that is a structural result, and it is the most genuinely novel thing this
review produced: **a document declares what it obsoletes, and can never declare what
obsoletes it** — because its successor had not been written yet. RFC 7231 contains no
reference to RFC 9110; the fact lives only in 9110 and in an external registry. So
obsolescence is knowable only from a document that is _not the source_, which means
per-source drift detection can never find it, however good the adapter. Drift is byte-level
by construction. Obsolescence is a different predicate, and accreta has already spent the
vocabulary implying it handles both.

**RT-11 — the cost of doing it right, and the price of doing it wrong.** Lint _detection_
costs zero model tokens; it is deterministic SQL. The cost is in fixing, and the five
finding kinds differ by roughly a thousandfold. One of them is a trap: `unverified-page`
looks like a missing field, so the cheap fix is to call `update_verified_revision` and move
on — which the constitution names as "the single most damaging thing you can do here". The
correct fix means re-reading a source that may be 125,000 tokens. **Any cost-driven model
choice selects for the damaging one**, and per RT-10 the result is undetectable forever.

## Adversarial content, and the control that cannot be built

The first six reviewers each assumed the corpus was benign. That is a fair assumption for
accreta as shipped — a local single-user tool where the operator usually wrote the pages — and
a poor one for the deployment the MCP server exists to serve. A shared knowledge base has
contributors who are not the operator, and that is a different system.

**RT-25 constrains every other finding here.** The confirm-token on `update_verified_revision`
is well designed, and its own comment claims three things that are all true: a token cannot be
produced without running the dry run, it cannot be replayed onto a different edit, and a plain
`confirm: true` flag would let a model skip straight to writing. All three were verified. Six
reviewers credited this design and they were right.

It still does not stop an injected instruction, and the reason is structural rather than a
defect. The dry run returns the token **in its own response**, so "call the dry run, then call
again with the token it gives you" is a two-step sequence the agent completes unaided. Measured
end to end with writes enabled: `last_verified_revision` went from `aaa1111` to `deadbeef`,
driven by text inside a page.

The distinction worth keeping is that the token is a **confirmation** mechanism, not an
**authorisation** one. Injection does not attack an agent's ability to follow a protocol; it
attacks its intent, and a confirmation step is exactly the kind of control an agent with
altered intent satisfies on its way to the goal. From which follows the constraint governing
everything else: **any defence living inside the same agent loop the injection controls is
defeated by the same move.**

**RT-26 widens the surface past where anyone would look.** The payload need not be in the body.
A page whose body is accurate and well-cited, whose provenance is present and whose links
resolve, can carry the instruction in a single `aliases` entry — which is indexed into FTS, is
the reason a search matches, and is never displayed. Review the markdown, run lint, run drift:
all clean. Five channels were measured — body, `title`, `aliases`, wikilink targets quoted back
by lint, and search snippets. Reviewing bodies is not sufficient.

**RT-27 is not a security finding at all**, and it is the most likely of these to bite someone.
The frontmatter preprocessor rewrites `[[wikilinks]]` into quoted strings because they are not
valid YAML — but it does not notice when the value is _already_ a double-quoted scalar, so
`title: "see [[a/b]]"` becomes `title: "see "[[a/b]]" b"`, YAML throws, and the page indexes
with **zero** frontmatter. Reproduced independently: all six declared fields gone, including
`canonical_source` and `last_verified_revision`, so the page cites nothing and drift can never
flag it. Double-quoting a title is a habit YAML encourages, and the constitution's own example
quotes `canonical_source`.

Credit where it is due, and it lowers the severity: `lint` catches this loudly, with three
findings, precisely because of the deliberate choice to index a page whose frontmatter will not
parse rather than refuse it. What lint does not do is name the cause — an author reading "no
canonical_source" would add a field that is already there.

**RT-30 and RT-31 are negative results, and they are worth as much as the rest.** Fifteen
adversarial inputs against the hand-rolled parser — 5MB values, 200,000 wikilinks, control
characters, prototype pollution, billion-laughs — and it held every time, with no crash and no
hang. Nineteen path-traversal targets, and none escaped the knowledge base. Two caveats keep
these honest: the billion-laughs guard belongs to the `yaml` library and accreta inherits it, so
it would regress if the dependency changed; and symlink containment is a **side effect** of
`walkMarkdown` checking `isFile()` rather than calling `stat`, which no comment records and no
test asserts. Anyone "fixing" symlink support removes it with nothing going red.

### What a defence can actually buy

No complete solution exists, and a proposal implying otherwise should be rejected on sight. The
peer-reviewed result that governs is that adaptive attacks break all eight defences evaluated,
at over 50% success — so a mitigation measured against a static attack suite has not been
measured against an adversary.

Ranked by what survives that constraint:

**Documenting the boundary** is the only item that cannot be defeated, because it does not try
to stop anything. The constitution binds the agent that _writes_ pages and says nothing to the
agent that _reads_ them. An operator enabling `ACCRETA_ALLOW_WRITES=1` should know they are
saying "any page in this corpus can direct a write". Hours of work, no mechanism, no erosion of
the three non-negotiables.

**Human-in-the-loop on the write path** is the only _technical_ control that breaks the loop,
because the confirming party is not the party the injection controls. It costs the unattended
re-verification workflow the write tool exists to enable — 200 pages becomes 200 confirmations,
which in practice means clicking through them, and rubber-stamped confirmation is worth nothing.
And it protects the write, not the context: the injected text still reaches the model through
all seven read tools.

**Delimiting untrusted content** in tool responses raises the attacker's cost and nothing more.
Ship it labelled as cost-raising, never as a fix.

**A lint rule** has one real virtue — it detects _outside_ the loop, in CI, where the injection
has no influence. It is also a blocklist, so paraphrase defeats it, and on a corpus that
documents accreta itself it would flag legitimate pages. Its false-positive rate is the entire
decision, and it has not been measured; the experiment is designed rather than guessed.

**A provenance-derived trust signal** is the option unique to accreta, and it should _not_ ship
as a security control. accreta genuinely knows which page came from which source at which
revision — structure most systems lack — but a hostile upstream document is faithfully cited and
fully provenanced, aliases are authored in the page and derive from no source, and the signal
goes to the model, which puts it back inside the loop. It is a provenance feature. Calling it a
defence would be the overselling this review exists to catch.

### Two legs, not three

Against the practitioner framework of private data, untrusted content and external
communication, accreta as shipped has **two of the three**. The corpus is private data and pages
are untrusted content, but the MCP server has no outbound network capability — grep finds no
`fetch`, no HTTP client. There is no exfiltration channel _inside accreta_.

That is stated as two-of-three rather than inflated to three, and it matters for attributing the
risk: the third leg is supplied by whatever _other_ tools the agent holds in the same session,
and accreta can neither know nor constrain them. It does not absolve the design; it locates the
responsibility.

## What was rejected, and why it is recorded here

A review that only accumulates findings is not reviewing. These were argued and did not
survive, and they are written down so they are not refiled.

**ADR-0004's 43ms is accurate.** One reviewer measured 82ms at 300 pages and concluded the
ADR was "off by ~2× on current hardware", proposing to correct it. The corpora were not
comparable: the ADR states 300 pages _and 600 links_, and both the reviewer's corpus and the
first orchestrator run carried roughly double that. Matched at the ADR's own density, three
runs, median: **29ms** — faster than the ADR claims. A second independent measurement at
seven runs agreed (31.9ms at 582 links, 31.0ms at 1,090). The proposal would have amended a
public ADR to make a correct measurement look wrong.

The generalisable lesson is uncomfortable and worth keeping: **the reviewer with the most
measurements made this error**, because volume of measurement is not comparability of
measurement.

**A citation was fabricated.** One reviewer cited Microsoft's engineering post on the
Windows git repository for "3.5 million files / 270GB, checkout at 2–3 hours, git status at
~10 minutes". Fetched at source: the post says 3.5M files and **300GB**, and gives **no
figure at all** for checkout or status — only that "many of the commands would take 30
minutes up to hours". The specific numbers do not exist in the cited source. One outright
citation failure in twenty-one, and it was the single citation that reviewer made outside
their measurement discipline; every SQLite and POSIX citation they made checked out
verbatim.

**Five places where the design is right and the criticism was mistaken:**

- **stdio-only is correct.** The MCP specification itself says clients _should_ support
  stdio wherever possible. It is the recommended default, not a legacy choice, and building
  a transport for a deployment story that does not exist would encode guesses.
- **Tools rather than resources for the primary path.** Resources are application-driven;
  accreta's loop must work unattended.
- **Rejecting incremental indexing survives** — and for a better reason than the ADR gives.
  `links` and `broken_links` are global, so an incremental update must re-resolve the whole
  repository or lint's dangling-link check silently starts reporting zero after a rename.
  That argument should replace the 43ms as the ADR's load-bearing sentence.
- **The stat-walk over content hashing is vindicated.** `revision()` on 100,000 files costs
  315ms, cleanly linear; content hashing would be ~13× on an operation that runs on every
  drift check. This is the ADR-0002 decision most tempting to attack, and the numbers say
  its authors were right.
- **Do not add model configuration.** accreta never calls a model, so a `models:` block
  would be advisory text the client is free to ignore — and a second place where phase
  semantics live, competing with the constitution, which is the artifact that actually
  reaches the model.

**`get_page` is not a problem.** Its flat 29.8KB is entirely a synthetic 400-sentence body;
real pages run 756–1,783 bytes. Acting on that number would mean bounding the one tool on
the surface that is already correctly bounded, while `check_drift` reaches 647% of a context
window.

## What this review did not cover

The gaps are named rather than left implicit.

**Prompt injection and adversarial corpus input have since been reviewed** — they were the two
largest gaps the first six lenses left, and a seventh reviewer covered them. See RT-25 through
RT-31 and `07-adversarial-content.md`. The parser held against fifteen hostile inputs and the
path boundary held against nineteen; the real damage was found elsewhere, in the write path and
in an ordinary quoted title.

Still unexamined: the CLI as a human surface, where the sibling test bed has already caught two
"drift silently reported success" defects; the upgrade path when the index schema changes under
an existing knowledge base, since `meta` carries no schema version; ADR-0005 as a distribution
constraint, tested on a machine without Bun; Windows, where SQLite cannot unlink an open file at
all and RT-01 and RT-06 therefore behave differently; and `examples/climate` as the shipped
artifact a new user reads first, which nobody linted or checked the citations of.

And the largest of all, still: **nobody measured whether the agent writes good pages.** Every
lens examined storage, retrieval, protocol, cost and now hostile input. The quality of the
compiled output is the product, and the nearest anyone came is an experiment card that has not
been run.

## A note on evidence grades

`MEASURED` means someone ran it and reported the numbers, the command and the machine.
`CITED` means a source was checked to contain the specific result relied on. `REASONED` is
an argument from the code, and it is the weakest grade — a finding that reaches only
REASONED says so in its own summary.

Of twenty-one distinct citations across the six reports, fifteen were verified and kept,
five were downgraded to REASONED (four of them on transfer grounds the reviewers had already
flagged themselves), and one was rejected outright. Two reviewers self-flagged the limits of
their own citations before the verifier looked, and both self-flags proved accurate.
