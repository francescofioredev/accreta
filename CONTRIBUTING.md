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
bun test
bun run typecheck
bun run lint
```

All four must pass before a pull request is ready. CI enforces them.

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

## Releasing

Publishing is triggered by a tag and gated on the full suite, because a tag is not a review and
npm will not let a version be republished. Before tagging:

```bash
bun test                                  # includes the packed-tarball test
bun run scripts/check-version.ts 0.1.2    # the tag you are about to push, without the v
cd packages/cli && bun pm pack --dry-run  # eyeball the file list
```

The `--dry-run` is worth the ten seconds. It prints exactly what would ship, which is the one
moment where an accidentally included secret or an oversized directory is cheap to notice.

Bump all five publishable packages in one commit — `@accreta/core`, the two adapters, `accreta`
and `@accreta/mcp-server`. They depend on each other by version, and `workspace:*` is resolved
at publish time, so one left behind names a version that was never published. Then tag `vX.Y.Z`
and push it; `.github/workflows/publish.yml` does the rest.

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

Publishing five packages is not atomic: npm takes them one at a time, and any of them can
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
