# Contributing to accreta

Thanks for looking. This project is developed in public and contributions are welcome —
with a little structure, so that nobody wastes an afternoon on something that was never
going to be merged.

## Open an issue before a pull request

This is the one real rule.

A pull request that changes architecture, adds a dependency, or alters the core method and
arrives without prior discussion will be closed with a pointer to a discussion thread. That
is not unfriendliness — it is the cheapest way to protect your time. Design disagreements
are much easier to resolve in an issue than in a diff you have already written.

**Welcome without prior discussion:**

- Bug fixes that come with a failing test demonstrating the bug.
- Documentation fixes, typos, clearer wording.
- **New source adapters** — the natural extension point of this project, and the most
  useful thing you can contribute. Use the *adapter proposal* issue template first; it asks
  the three questions any new source type has to answer.

**Out of scope without an accompanying ADR:**

- Changes to the core method: the provenance rules, drift detection, or the negative rules
  ("never duplicate the source", "never synthesize beyond the evidence"). These are the
  project's substance rather than implementation details. If you think one is wrong, that is
  a genuinely interesting conversation — open an issue and make the case.

## Project conventions

- **English.** Code, comments, docs, commits, issues.
- **An ADR for every architectural decision.** `docs/adr/NNNN-title.md`. It records *why*,
  including the alternatives rejected. A decision without a written rationale gets
  relitigated every six months.
- **A test for every bug fix.** The test must fail before the fix and pass after it.
- **No claim without a measurement.** If a change is described as faster or more accurate,
  the pull request carries the numbers.
- **Provenance applies to us too.** When documentation states something about behavior, it
  cites the code.

## Development

```bash
bun install
bun run test
bun run typecheck
bun run lint
```

All four must pass before a pull request is ready. CI enforces them. Use Bun 1.4 or newer.

`bun run test` passes `--conditions=@accreta/source`, which resolves the workspace packages to
their `src/`. A plain `bun test` looks for the `dist/` that exists only while packing, and fails.
Anything else you run from the repository needs the flag too, for example
`bun --conditions=@accreta/source packages/cli/src/bin.ts lint`.

## Pull requests

- Branch off `main`; `main` is protected and takes no direct pushes.
- One logical change per pull request. Two unrelated fixes are two pull requests.
- Explain *why* in the description, not only *what* — the diff already shows what.
- Link the issue the pull request resolves (`Fixes #N`). Note that GitHub does not honor
  the keyword inside backticks.
- Merges are squashed, keeping history linear and readable as a narrative.
- Your pull request needs one approving review from a code owner. Force pushes and branch
  deletion on `main` are blocked outright.

> **On the maintainer's own pull requests.** GitHub does not allow anyone to approve their
> own pull request, so with a single maintainer the review requirement would deadlock every
> change. Until there is a second reviewer, the maintainer merges their own work using an
> admin override, and the requirement stands for everyone else. This is written down rather
> than left implicit because a rule that is quietly bypassed is worse than one that is
> honestly scoped — and when a second maintainer arrives, the override stops being used and
> nothing else has to change.

## Working in parallel

The launch work ([#109](https://github.com/francescofioredev/accreta/issues/109)) runs in
lanes. Each lane is an epic that one session works end to end, in its own worktree off `main`:

```bash
git worktree add ../accreta-<lane> -b <lane>/<issue>-<slug> origin/main
```

| Lane        | Epic                                                            | Owns                                                                                                                                                    |
| ----------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| groundwork  | [#110](https://github.com/francescofioredev/accreta/issues/110) | publish checks, `docs/architecture.md`, ADR status lines, the layout of `packages/cli/src/`                                                             |
| runtime     | [#115](https://github.com/francescofioredev/accreta/issues/115) | build config, dependencies and `bun.lock`, the SQLite driver, git process spawning, `.github/workflows/`, the `init`, `doctor` and `mcp install` commands |
| provenance  | [#122](https://github.com/francescofioredev/accreta/issues/122) | `packages/core/src/query/`, `packages/core/src/source/` except `drift.ts`, the fs and delegated adapters                                                |
| surfaces    | [#127](https://github.com/francescofioredev/accreta/issues/127) | the other CLI commands, `packages/mcp-server/src/`, `templates/`, `skills/`                                                                             |
| evidence    | [#133](https://github.com/francescofioredev/accreta/issues/133) | `bench/`, the eval, the demo knowledge base, `drift.ts`, git change detection, the `drift` command, the PR action                                       |
| launch      | [#141](https://github.com/francescofioredev/accreta/issues/141) | `README.md`, the release, the announcement                                                                                                              |
| team access | [#145](https://github.com/francescofioredev/accreta/issues/145) | HTTP transport, auth, sync loop, deployment                                                                                                             |

- Take the next open task in your lane whose blockers are all closed: `launch-critical`
  first, then the lowest number. One task is one pull request.
- Stay inside your lane's paths. A task that has to touch another lane's file says so in its
  body; keep that change small and name it in the pull request.
- State lives on the issue, not in a local file. Comment when you start, link the pull
  request, close the issue on merge.

Hotspots, where two lanes would otherwise collide:

- **Dependencies and `bun.lock`** change only in the runtime lane. Another lane that needs a
  dependency lands it first, alone, in a small pull request.
- **`README.md`** is frozen until the launch lane, except for factual fixes. New docs go under
  `docs/`.
- **CLI commands** live one per file in `packages/cli/src/commands/`, with shared helpers in
  `commands/shared.ts`. A new command is a new file there; in `packages/cli/src/main.ts` it
  adds its import, its dispatch line and its line in `USAGE`, and touches nothing else.

## Releasing

Publishing is triggered by a tag and gated on the full suite, because a tag is not a review and
npm will not let a version be republished. Before tagging:

```bash
bun run test                              # includes the packed-tarball test
bun run scripts/check-version.ts 0.1.4    # the tag you are about to push, without the v
cd packages/cli && bun pm pack --dry-run  # eyeball the file list
```

The `--dry-run` is worth the ten seconds. It prints exactly what would ship, which is the one
moment where an accidentally included secret or an oversized directory is cheap to notice.

Bump all seven publishable packages in one commit — `@accreta/core`, the four adapters,
`accreta` and `@accreta/mcp-server`. They depend on each other by version, and `workspace:*` is
resolved at publish time, so one left behind names a version that was never published. Then tag
`vX.Y.Z` and push it; `.github/workflows/publish.yml` does the rest.

The setup skill has its own number, `metadata.requires` in `skills/accreta-setup/SKILL.md`, and
it is not the version being released: it is the earliest release that has every command the
skill uses. Raise it when the skill starts using a new one. `check-version.ts` refuses a tag
older than it, because the skill installs from git and would otherwise send a reader to a
command nobody can install yet.

`packages/adapters` and `bench` stay private: they are a test harness and a benchmark, not
things anyone installs.

Publishing uses npm's trusted publishing (OIDC): the workflow proves its identity to the
registry and receives a short-lived token, so there is no secret to store or rotate. It has to
be configured once per package on npmjs.com, under the package's *Settings → Trusted
publisher*, naming this repository and `.github/workflows/publish.yml`.

That is also why the publish step runs `npm publish` rather than `bun publish`, in an
otherwise entirely Bun repository: bun cannot do the OIDC exchange
([oven-sh/bun#22423](https://github.com/oven-sh/bun/issues/22423)), and npm is withdrawing the
2FA-bypass tokens that were the alternative — sensitive operations in August 2026, direct
publishing in January 2027.

Publishing seven packages is not atomic: npm takes them one at a time, and any of them can
fail — a scope without a trusted publisher configured, a network blip. The workflow therefore
skips whatever is already at the tag's version, so re-running a half-finished release picks up
where it stopped instead of dying on the first package that already succeeded. Re-running is
always safe; it is the intended way to finish a partial release.

Each package needs its own trusted publisher on npmjs.com, including the unscoped `accreta` —
configuring the `@accreta` org does not cover it, since it belongs to the user rather than the
scope. A missing one shows up as `404 ... could not be found or you do not have permission`,
which is npm's way of saying 403.

It costs one thing worth knowing about. `bun publish` rewrites `workspace:*` to real versions
when it packs; `npm publish` copies the string through untouched, and a published package
carrying `workspace:*` cannot be installed by anybody. So the internal dependencies name plain
versions, and a test in `packages/cli/test/packaging.test.ts` fails if the protocol ever comes
back. Bumping a version means bumping it in every manifest that names it.

## Measuring adoption

```bash
bun run adoption
```

npm's download counter is not an adoption number. It counts tarball fetches, does not filter
automation, and pays every publish a tribute of 100-150 fetches per version per package from
mirrors and security scanners. The first release drew 1,836 downloads with no human behind
any of them.

The report prints the daily counts, how much of the total the publishes explain, and a
three-line checklist of the things a real user leaves behind: a sustained rate above npm's
own noise floor, a repository that depends on the package, a referrer that is not
`github.com`. It cites every threshold it compares against, and prints `?` rather than `no`
for a source that did not answer. `docs/research/2026-08-npm-downloads.md` records the first
reading.

The GitHub section needs `gh` authenticated with push rights; without it that section is
skipped and the rest still works.

## Reporting a bug

Use the bug template and include: what you expected, what happened, and the smallest
reproduction you can manage. For anything involving indexing or drift, the output of
`accreta lint` is usually the fastest path to a diagnosis.

## Security

Do not open a public issue for a security problem. Use GitHub's private vulnerability
reporting on this repository.

## Code of conduct

Be decent. Discuss the work rather than the person. The maintainer reserves the right to
lock threads that stop being productive.
