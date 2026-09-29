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
cannot place it: every page would come back as "a revision this source cannot place".

The only token is the workflow's own `GITHUB_TOKEN`, with `pull-requests: write` to comment and
`contents: read` to check out. Nothing else is needed.

## Inputs

| Input | Default | |
|---|---|---|
| `working-directory` | `.` | The knowledge base to check. Each one gets its own comment. |
| `comment-when-clean` | `false` | Also post when drift finds nothing. |
| `fail-on-drift` | `false` | Fail the job when `accreta drift` exits non-zero. |
| `github-token` | the workflow's | Token that posts the comment. |

Output: `pages-in-doubt`, the number of pages whose cited lines changed.

## What the comment says

- **Pages in doubt**: a page is listed only when lines it cites changed. Each row names the
  page, the cited path and lines, the footnote, and the commit those line numbers belong to.
  The heading names the commit the pull request brings the source to.
- **Re-pin only**, folded: cited lines that moved but did not change. The row gives the new
  line range.
- **Other pages** on the old revision are counted, not named. Their cited lines are untouched.
  That lowers the doubt without clearing it: a claim can rest on a line nobody cited.

The same data, unabridged, is `accreta drift --json`.

## When it posts

- One comment per knowledge base, found again by a hidden marker and edited in place on every
  push. It never posts a second one.
- A new comment appears only when `accreta drift` exits non-zero, unless
  `comment-when-clean` is set. An existing comment is always updated, so it turns clean when
  the pages are re-verified.
- The report also goes to the job summary, whatever happens to the comment.

## Pull requests from forks

GitHub gives a `pull_request` run from a fork a read-only token, whatever the workflow asks for.
The action detects a fork, skips the comment, and leaves the report in the job summary. The same
goes for any other run whose token is refused (403), such as Dependabot's.

Do not switch to `pull_request_target` to get a write token. It would run the fork's code, and
`accreta reindex` parses the fork's pages, with that token in reach.

## What it assumes

The comment reports drift at the pull request's merge commit. If the base branch already has
drift, those pages appear too. Keep the base branch clean and the comment names exactly what the
pull request changed.

A source that cannot diff contents (the `fs` adapter) can only say which files changed. Its
pages are listed with "file changed" rather than a line range.
