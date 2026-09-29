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
comparison with the base branch below needs the history too.

The only token is the workflow's own `GITHUB_TOKEN`, with `pull-requests: write` to comment and
`contents: read` to check out. Nothing else is needed.

## Inputs and outputs

| Input | Default | |
|---|---|---|
| `working-directory` | `.` | The knowledge base to check. Each one gets its own comment. |
| `comment-when-clean` | `false` | Also post when no page is newly in doubt. |
| `fail-on-drift` | `false` | Fail the job when a page is newly in doubt. |
| `github-token` | the workflow's | Token that posts the comment. |
| `comment-author` | `github-actions[bot]` | Login of that token, used to find the comment again. Change it with `github-token`. |

| Output | |
|---|---|
| `pages-newly-in-doubt` | Pages with a cited line in doubt that the base branch did not have in doubt. |
| `pages-in-doubt` | All pages whose cited lines changed, including those. |
| `pages-unplaceable` | Pages verified at a revision the source cannot place. |

## What the comment says

A `pull_request` checkout is a merge commit. The action also runs drift on its first parent, the
base branch, and compares the two by page, footnote, path and line range.

- **Newly in doubt**: citations whose lines changed at the merge commit but not on the base
  branch. Each row names the page, the cited path and lines, the footnote, and the commit those
  line numbers belong to. The heading names the commit the source is at; re-pin after merge,
  because a merge or squash commit gets a new SHA.
- **Already in doubt on the base branch**, folded: citations the base branch already had in
  doubt. They stay listed, because this change may have touched the same lines again.
- **Re-pin only**, folded: cited lines that moved but did not change, with the new range.
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
- A new comment appears only when a page is newly in doubt, unless `comment-when-clean` is set.
  An existing comment is always updated, so it turns clean when the pages are re-verified.
- `fail-on-drift` also keys on pages newly in doubt, not on drift's exit code, so drift the base
  branch already had does not fail every pull request.

## Pull requests from forks

GitHub gives a `pull_request` run from a fork a read-only token, whatever the workflow asks for.
The action detects a fork, skips the comment, and leaves the report in the job summary. The same
goes for any other run whose token is refused (403), such as Dependabot's.

Do not switch to `pull_request_target` to get a write token. It would run the fork's code, and
`accreta reindex` parses the fork's pages, with that token in reach.

## Limits

- Without a merge commit (a `push` run, or a shallow checkout) there is no base to compare with,
  and every page in doubt counts as new.
- A citation the base branch already had in doubt goes in the folded section even when this
  change touched its lines again. Two drift reports cannot tell those apart.
- A source that cannot diff contents (the `fs` adapter) can only say which files changed. Its
  pages are listed with "file changed" rather than a line range.
