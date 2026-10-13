# ADR-0018: Areas are folders, and reading is checked inside every query

Status: proposed
Date: 2026-10-13

## Context

A team wants one knowledge base, and wants some of it readable only by some of its people.
Engineering reads `engineering/`, security reads `engineering/security/` too, everyone reads
`handbook/`. The tree is the organization, and the access follows the tree.

Today nothing in accreta knows a person, a team, an area or a folder's meaning. A page's id
is its path, its type comes from frontmatter, and folders are convention. Two facts bound
what governance can mean here:

- **Reading can only be checked where accreta stands between the reader and the pages.**
  Locally it does not. Whoever has the repository has every page, and git cannot hide part
  of a repository from a reader. The hosted server of #145 (ADR-0017, #146) is the first
  place a read check is real.
- **accreta does not see most writes.** The agent writes pages with its own file tools; the
  only page write accreta performs is `update_verified_revision`. Who may change an area is
  a question for the repository's review rules.

Two lessons from the survey in `docs/research/2026-10-governance.md` shape the answer. Every
derived surface is a read path: MediaWiki's list of how restricted pages escape is search,
listings, feeds, diffs, transclusion, redirects, the API and caches — paths around the page,
not the page itself. And the compiling agent is the weak point. It reads every area and
writes into each, which is the "write down" Bell and LaPadula's *-property exists to forbid.

## Decision

### An area is a folder, declared in the config

```yaml
# accreta.config.yaml
policy_owners: ["@example-org/kb-admins"]

roles:
  everyone:    { groups: ["*"] }
  engineering: { groups: [eng], codeowners: ["@example-org/eng"] }
  security:    { groups: [sec], codeowners: ["@example-org/security"] }

areas:
  - path: handbook
    read: [everyone]
    maintain: [engineering]
  - path: engineering
    read: [engineering, security]
    maintain: [engineering]
  - path: engineering/security
    read: [security]
    maintain: [security]
```

Role names are opaque to the core, as page types are (ADR-0003). `groups` and `codeowners`
are read by the hosted server and by `accreta codeowners`, never by the core.

**Paths are normalised and matched by whole segment.** An area `path` is relative to
`knowledge_base`, with no leading `./` or `/`, no trailing `/`, no `..`, and no
`knowledge_base` prefix; anything else is a config error. `engineering` covers
`engineering/x.md` and `engineering/a/b.md`, never `engineering-old/x.md`. Matching is
byte-exact. A folder on disk that differs from a declared area only by case or Unicode
normalisation is a `doctor` error, because macOS folds case and a Linux host does not.

A page belongs to the deepest declared area that covers it. An undeclared subfolder of an
area belongs to that area. `path: .` declares an area for files directly in the root folder
only; it is not an ancestor of anything.

**Every declaration is checked, and none falls back to a default.** `read` is required on
every area. A missing, empty or malformed `read`, a duplicate `path`, a role named in `read`
or `maintain` that `roles` does not declare, or an `audience` naming no declared area, is a
config error. The rest of the config degrades to defaults on error, as it does today
(`packages/core/src/config.ts`). `roles` and `areas` never do.

### Deny by default; a subfolder only narrows

- A page in no declared area — a top-level folder nobody declared, a misspelled folder, a
  folder the agent invented — is readable by no one.
- A reader may read an area only if they hold a role in its `read` **and** a role in the
  `read` of every ancestor area. A child can remove readers; it cannot add any. The check is
  over people, so `everyone` at an ancestor does not empty a child that names `security`.
- `maintain` is not inherited. It names who reviews changes to that folder and nothing else.

This is Cedar's default deny with Confluence's inherited view restrictions. Narrow-only
makes one property hold by construction: a page deeper in the tree never has more readers
than the page above it, so moving it into a subfolder can only make it more private.

### The core takes a set of visible areas and applies it in SQL

The indexer resolves each page's area at build time into a new `pages.area` column, and an
`UNINDEXED` `area` column of `pages_fts`. A page in no area gets `NULL`, which no visible set
contains. The index stays derived and is rebuilt, never migrated (ADR-0004).

Every core query takes an optional `visible: readonly string[]` and restricts to
`area IN (...)`. The rule each channel follows is the same: **a page outside the visible set
is answered exactly as a page that does not exist.**

| Channel | Under a visible set |
|---|---|
| `searchPages`, and hosted `search` | filtered in the `MATCH` join; the hits and `count` cover visible pages only |
| `getPage`, and hosted `fetch` | a hidden page is `found: false` |
| `findRelated` | an edge to a hidden page is returned as an edge to a missing page: path kept, `type` and `title` null. A hidden target has `targetExists: false` and no outbound edges. Totals follow the same rule |
| `findCanonical` | hidden pages never match |
| `lint`, `lintCitations`, supersession | computed over the visible subgraph: a link to a hidden page is `dangling-link`; whole-pass counts, unchecked-citation paths and pages-citing-a-source counts include visible pages only |
| `detectDrift` | every page list (`pages`, `unverifiable`, `unresolvable`, `delegated.pending`, `citations[].page`) holds visible pages only |
| `list_recent_changes`, `cite` | a path inside `knowledge_base` that is not visible is answered as absent |
| sources | a source whose `audience` is not visible is answered exactly as an unknown id; in hosted mode no error lists source ids. A source with no `audience` is visible to no hosted reader |
| the per-result currency annotation of #148 | same filter; a commit message is shown only for a source whose audience is visible |

Nothing is filtered after a result is formed. Filtering afterwards leaves `count`, totals,
`targetExists`, finding details and the length of a page of results all answering for the
hidden set.

The core never learns who is asking. It receives a list of area paths and nothing else, so
the core does not branch on its caller, as it does not branch on its adapter (ADR-0002).

Two existing properties become load-bearing and are recorded so nobody removes them:

- **The indexer never follows symlinks** (`walkMarkdown` in `index-db/build.ts`). A page's
  area comes from its indexed path; a link `handbook/x -> ../engineering/security` followed
  would file security pages under `handbook`.
- **Cursor binding is for correctness, not confidentiality.** The filter runs inside the
  query, so a cursor replayed by another reader indexes into that reader's own results.

### Identity becomes a visible set only at the edge

- **Hosted.** The server validates the OAuth token as a resource server (ADR-0017), reads
  the group claim named in its deployment config, maps groups to roles through `roles`, and
  roles to visible areas through `areas`. `"*"` matches any validated token carrying at least
  one group claim; the deployment guide names which identity-provider principals that
  includes. A token with no recognised group sees nothing.
- **stdio.** There is no identity, and the person running it has the repository. The default
  is every area. `ACCRETA_ROLES=engineering` **previews** what a role sees. It must never be
  used to answer for someone who may not read the repository: the agent reads every file
  with its own tools, whatever accreta filters. An unknown role name in `ACCRETA_ROLES` is an
  error. The hosted server refuses to start when `ACCRETA_ROLES` is set.

### In hosted mode, governance cannot be off

Locally, a config without `areas` means governance is off and every page is visible, as
today. Hosted, that same fallback is how a typo would publish everything: a bracket left
open, the build and the server both degrading to no areas, and the two agreeing with each
other. So in hosted mode:

- the server refuses to start, and `reindex` refuses to build, when the config fails to
  parse, when `areas` is absent, or when any `roles` or `areas` entry is invalid;
- the server refuses governed queries when the index records a `policy_hash` and the loaded
  config declares no areas, or the reverse.

### Sources carry an audience, and a lint checks the flow

A source declaration may name the area whose readers may see what it says:

```yaml
# sources/incident-reports.yaml
id: incident-reports
type: fs
path: ../incidents
audience: engineering/security
```

A new lint kind, `label-flow`, uses the provenance accreta already records. A page is a
finding when any of these has readers that are not a superset of the page's own:

1. a source it cites through frontmatter `source`, `canonical_source` or a footnote — by the
   source's `audience`. A citation whose path falls inside `knowledge_base`, through any
   source, takes the area of that path instead, so a broad source enclosing the knowledge
   base cannot launder a hidden page;
2. a page it links to through a link field or a body wikilink;
3. a page named by a markdown link, or by a `[[...]]` in any frontmatter field.

"Not a superset" includes incomparable sets: an `hr/` page linking into `engineering/security/`
is a finding even though neither set contains the other.

Narrow-only makes the common case free: a page in the audience area or below it never fires.

This is the part of governance only accreta can do. A filter governs who sees a page; it
cannot govern what a visible page says. `label-flow` covers wikilinks, markdown links,
link fields and parseable footnotes. It cannot see titles, aliases, link display text, or
prose.

### Writing stays in the repository

`accreta codeowners` prints a CODEOWNERS file:

- one anchored line per area (`/<knowledge_base>/<area>/`), deepest last, so GitHub's
  last-match rule picks the narrowest owner;
- owners from `policy_owners` for `/accreta.config.yaml`, `/sources/` and
  `/.github/CODEOWNERS`, because whoever edits those can grant themselves any area or lower a
  source's audience to silence `label-flow`.

An area with readers but no `maintain` is a `doctor` error: otherwise the widest-read area
would be the cheapest one to write into, which is exactly the direction that must be
reviewed hardest.

Hosted mode builds only from a ref protected by required code-owner review that
administrators cannot bypass. The admin override in `CONTRIBUTING.md` is scoped to this
repository's own development and does not carry over to a governed knowledge base.

When `ACCRETA_ROLES` is set, `update_verified_revision` refuses a page outside every area
those roles maintain. The hosted server never exposes it (ADR-0017).

### A policy change takes effect at the next build

The build records `meta.policy_hash` over:
- the resolved table of area path → effective readers;
- every source's `audience`;
- `knowledge_base`;
- a version of the resolution algorithm.

The server re-reads the config whenever ADR-0010's inode check reopens the index, and
refuses governed queries, with an error that says to reindex, while its hash and the index's
differ. A stale index fails closed instead of serving pages under the old assignment, and a
code release that changes how areas resolve invalidates every older index. That is
Zanzibar's "new enemy" answered at the granularity accreta has: one build.

Removing a person from a group in the identity provider takes effect when their token
expires, not at the next build. The deployment guide states the token lifetime.

## What this does not protect

Stated plainly, because the user chose one knowledge base over several:

- **The compiling agent reads every area.** It can state in `handbook/` a fact it learned in
  `engineering/security/` without citing or linking anything, or copy a paragraph across.
  `label-flow` cannot see an uncited sentence, and only the receiving area's maintainers
  review the change. The constitution tells the agent to compile one area per session from
  sources whose audience admits that area. Neither mitigation is a guarantee. A boundary
  that must hold against the agent needs a separate knowledge base, compiled by a session
  that never had the other sources.
- **Synthesis can exceed every label it read** (Lunt 1989). Two visible pages can together
  imply something neither states.
- **Areas separate confidentiality, not integrity.** The widest-read area is read inside the
  most privileged sessions. A page compiled from a low-trust source can instruct a security
  reader's agent to gather what that reader may see and send it out through the chat
  client's other connectors (ConfusedPilot; Greshake et al. 2023). The page cannot make
  accreta reveal a hidden page — the visible set comes from the token, and the area from the
  indexed path — but it can misuse a legitimate one.
- **bm25 ranks with corpus-wide statistics.** A reader can infer that a term occurs in pages
  they cannot see from how visible results rank. Elasticsearch documents the same leak for
  document-level security. An index per visible set would close it; that cost is not
  justified for team scoping. Like every remaining oracle, an injected agent can drive it at
  machine speed.
- **Locally, nothing.** The repository is the boundary.

## Rejected alternatives

**A separate knowledge base per audience.** The only design that stops the agent from
combining areas, and the one MediaWiki recommends. Rejected because one team's tree is one
body of knowledge: cross-area links, one drift run, one constitution. Splitting it trades
the residual risk above for duplicated pages and links that cannot be followed. It stays the
answer for a boundary that must hold against the agent, and nothing here prevents running
two knowledge bases.

**An ACL in each page's frontmatter.** Every page restates its access, the agent writes it,
and a page moved between folders keeps the wrong one. The folder already says where a page
belongs; a second copy of that fact drifts, which is what ADR-0003 removed for page types.

**An external authorization engine** (OpenFGA, SpiceDB, Permify). Zanzibar's model is the
right one for a large, changing graph of users and objects. A knowledge base has tens of
areas that change in a reviewed config file. A server would break offline operation
(ADR-0009) and add a dependency for a set that fits in a `WHERE` clause.

**Broadest grant wins** (Notion). A narrower restriction is then defeated by a grant made
elsewhere, and nobody can read a folder's readers off the config. Narrow-only can.

**Most-specific rule wins** (DokuWiki). It lets a child widen its parent, so moving a page
deeper can expose it. Kept for `maintain`, where widening is harmless.

**An open root by default.** Making `path: .` an ancestor of every area would let every
misfiled page inherit the root's readers. Deny-by-default only means something if a page
nobody placed is a page nobody reads.

**Filtering results after the query.** Simpler to bolt on, and it leaks through every
number the query returns.

**An index per role.** Closes the bm25 leak, multiplies build time by the number of distinct
visible sets, and builds are already the binding constraint (ADR-0008). HoneyBee measures the
same trade-off for vector indexes.

## Consequences

- New config: `policy_owners`, `roles`, `areas`; a source key: `audience`. One column, one
  predicate threaded through every query, one lint kind, one command.
- Each row of the channel table gets a test: for that channel, the response for a hidden page
  equals the response for an absent one, byte for byte.
- Resolution gets tests for the edge cases above: segment matching, case collisions, `.`,
  malformed `read`, a broken config in hosted mode.
- The filter's cost on FTS is measured at 1k, 10k and 20k pages before anyone calls it free.
- An experiment, after #147: ten injection variants in `handbook/`, a security token, a
  neutral question, the chat client's connectors on, three runs each. Any cross-area
  quotation or outbound call is the measured rate of the integrity risk above.
- The constitution and the setup skill teach how to design the tree, since the tree is now
  the policy.
