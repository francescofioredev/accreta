# Drift on pull requests

A pull request that changes a source can quietly invalidate pages in the knowledge base. The
accreta drift action runs `accreta drift` on every pull request and posts one comment naming
the pages whose cited lines the change touched. No model is involved: it compares each
footnote's line range with the diff ([ADR-0015](adr/0015-drift-at-line-granularity.md)).

## Set it up

Add `.github/workflows/drift.yml`:

```yaml
name: Drift
on:
  pull_request:

permissions:
  contents: read
  pull-requests: write

concurrency:
  group: ${{ github.workflow }}-${{ github.event.pull_request.number }}
  cancel-in-progress: true

jobs:
  drift:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: francescofioredev/accreta@main # pin a release tag or commit once one ships the action
        with:
          working-directory: . # where accreta.config.yaml lives
```

`fetch-depth: 0` matters. A citation names the commit its lines belong to, and a shallow clone
cannot place it: every page would come back as "a revision this source cannot place". The
action refuses a shallow checkout with an error that says so.

The only token is the workflow's own `GITHUB_TOKEN`, with `pull-requests: write` to comment and
`contents: read` to check out. Nothing else is needed.

## Inputs and outputs

| Input | Default | |
|---|---|---|
| `working-directory` | `.` | The knowledge base to check. Each one gets its own comment. |
| `comment-when-clean` | `false` | Also post when nothing is new. |
| `fail-on-drift` | `false` | Fail the job when a page is newly in doubt or newly unplaceable, or a source declaration newly does not load. |
| `github-token` | the workflow's | Token that posts the comment. |
| `comment-author` | `github-actions[bot]` | Login of that token, used to find the comment again. Change it with `github-token`. |

| Output | |
|---|---|
| `pages-newly-in-doubt` | Pages with a cited line in doubt that the base branch did not have in doubt. |
| `pages-in-doubt` | All pages whose cited lines changed, including those. |
| `pages-unplaceable` | Pages verified at a revision the source cannot place. |
| `pages-newly-unplaceable` | Those the base branch did not have at the same revision. |
| `sources-unloaded` | Source declarations that did not load, so nothing citing them was checked. |
| `sources-newly-unloaded` | Those the base branch did not already fail to load with the same `id` and at least as many citing pages. |

With a token other than the workflow's, set `comment-author` to the login it posts as. The action
warns when the two differ, because the comment would not be found again on the next push.

## What the comment says

The action also runs drift on the base branch and compares the two reports by page, footnote,
path, line range and the revision the citation names. On GitHub's default checkout, the test
merge, the base is its first parent. On a checkout of the pull request's head (`ref:
head.sha`), it is the merge base with the base branch, because the head's own first parent is its
previous commit when the branch has merged main.

- **Newly in doubt**: citations whose lines changed at the merge commit but not on the base
  branch. Each row names the page, the cited path and lines, the footnote, and the commit those
  line numbers belong to. The heading names the commit the source is at; re-pin after merge,
  because a merge or squash commit gets a new SHA.
- **Already in doubt on the base branch**, folded: citations the base branch already had in
  doubt at the same revision. They stay listed, because this change may have touched the same
  lines again. A citation re-pinned since then names a new revision, so it counts as new.
- **Re-pin**, folded: cited lines that moved but did not change, with the new range, including
  those on a page that is also in doubt.
- **Revisions nobody can place**, folded: the pages verified at them, by name.
- **Other pages** on the old revision are counted, not named. Their cited lines are untouched.
  That lowers the doubt without clearing it: a claim can rest on a line nobody cited.

The comment is kept under 60,000 characters. Rows newly in doubt go first; what does not fit
ends in "…and N more rows". If GitHub still refuses the body, the comment falls back to its
headline. The full report is always in the job summary, and `accreta drift --json` has all of it.

Run the same comparison locally with `accreta drift --format github --base base.json`, where
`base.json` is `accreta drift --json` from the base branch.

## When it posts

- One comment per knowledge base, found again by a hidden marker and its author's login, and
  edited in place on every push. It never posts a second one.
- A new comment appears only when a page is newly in doubt, newly at a revision nobody can
  place, or a source declaration newly did not load, unless `comment-when-clean` is set. An existing
  comment is always updated, so it turns clean when the pages are re-verified.
- `fail-on-drift` keys on the exit code of `accreta drift --base`, which fails only on those same
  three, so drift the base branch already had does not fail every pull request.
- A source declaration that did not load counts as new unless the base branch already failed to
  load the same file with the same `id` and at least as many pages citing it. Its error can change and it
  stays inherited; a new `id` or more citing pages make it new. One page removed and another added
  keeps the count, so that swap goes unnoticed. Inherited ones are still listed, in the headline
  and folded, because nothing citing them is checked until the declaration is fixed.

## The exit code with `--base`

`accreta drift --base base.json` exits 1 only on what the change put in doubt: a page newly in
doubt, a page newly at a revision nobody can place, or a source declaration newly not loading.
Pages behind their source whose cited lines only moved or stayed untouched are still reported
(`repin`, `other_stale_pages`) but no longer fail. Under `--strict` it also fails on a page that
newly records no revision, or newly waits on the agent for a delegated source. Those are compared
by page, so a page that gains a revision, or is re-verified at a new one, is not new. In text,
a first line says how many pages are newly in doubt and how many the base branch already had.

Without `--base`, nothing changes: drift exits 1 on every page behind its source, moved and
untouched ones included, and on every unplaceable revision and unloaded declaration.

With no base to compare with, the action passes an empty report, so every page counts as new and
the exit code agrees with the counts.

## Pull requests from forks

GitHub gives a `pull_request` run from a fork a read-only token, whatever the workflow asks for.
The action detects a fork, skips the comment, and leaves the report in the job summary. The same
goes for any other run whose token is refused (403), such as Dependabot's.

Do not switch to `pull_request_target` to get a write token. It would run the fork's code, and
`accreta reindex` parses the fork's pages, with that token in reach.

## Limits

- Outside a pull request, or on a checkout that is neither its head nor GitHub's test merge,
  there is no base to compare with, and every page counts as new.
- A citation the base branch already had in doubt, still pinned to the same revision, goes in
  the folded section even when this change touched its lines again. Two drift reports cannot
  tell that case apart; they can when the citation was re-pinned in between.
- A source that cannot diff contents (the `fs` adapter) can only say which files changed. Its
  pages are listed with "file changed" rather than a line range.
