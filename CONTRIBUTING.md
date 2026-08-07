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
