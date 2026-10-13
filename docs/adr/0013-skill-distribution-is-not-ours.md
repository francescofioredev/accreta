# ADR-0013: Skill distribution is not ours to own

Status: accepted, amended 2026-10-13 (`doctor` reads the installed skill; see the end)
Date: 2026-09-08

## Context

The setup skill stopped being a convenience when delegated sources shipped. accreta declares a
source behind a connector and emits a work order; the agent does the reading, and the skill is
what drives it. ADR-0012 put it plainly: a delegated source is inert until the skill reaches the
agent.

[#26](https://github.com/francescofioredev/accreta/issues/26) had specified how it would get
there — an installer handling the five states a target can be in: **absent**, **clean**,
**stale**, **modified**, **foreign**. It was deferred three times, always for the same reason:
`modified` and `foreign` demand a policy about whose changes win, and there was no evidence
about how anybody actually installs a skill. The design would have preceded the practice.

The evidence arrived as an ecosystem rather than as a user. `npx skills`
([vercel-labs/skills](https://github.com/vercel-labs/skills)) discovers this repository's layout
with no changes on our side: it finds `skills/<name>/SKILL.md`, selects with `--skill`, installs
per agent into `.claude/skills/` or `~/.claude/skills/` with `-g`, and carries `update` and
`remove`.

## Decision

**accreta ships no installer.** The documented channel is `npx skills`, verified against this
repository before being written down.

**Prefer the pinned form.** `npx skills add <repo>` takes the default branch at the moment it
runs, and `main` is normally ahead of the last release. A GitHub tree URL carrying a tag is
honoured, so the README leads with the form that cannot skew:

```bash
npx skills add "https://github.com/francescofioredev/accreta/tree/v$(accreta --version)/skills/accreta-setup"
```

**The skill declares the release it needs.** `metadata.requires` in the frontmatter names the
earliest release with every command the file uses — a fact about the file, not about when it was
copied. `scripts/check-version.ts` refuses a tag older than it, so a skill can never reach a
reader naming a command nobody can install yet. It is `metadata.requires` rather than a
top-level key because the Agent Skills frontmatter schema admits only a fixed set of top-level
keys, and `metadata` is where the ecosystem's own skills put this.

**The package keeps its copy.** `skills/` still ships in the tarball, version-locked to the code
beside it, for anyone who would rather not fetch from a branch.
`packages/cli/test/packaging.test.ts` asserts it is there, because no command reads it and its
absence would otherwise be discovered by a user.

## Alternatives rejected

**The five-state installer, with a receipt.** A manifest inside the installed directory
recording a hash per file, so `stale`, `modified` and `foreign` are told apart from evidence
rather than guessed; refuse on `modified`; `--force` moves the directory aside rather than
deleting it. It is a sound design and we would have had to maintain it, along with a table of
every agent's skills directory, against an ecosystem CLI that already tracks 80-odd agents. The
five states describe a problem we would have been solving alone.

**A symlink into the installed package.** The skill would follow `npm update` and staleness
could not happen. It dangles when `node_modules` is rebuilt, and a global skills directory
pointing into one project's `node_modules` is wrong the moment another project is opened.

**Copying from the npm package via `accreta skill install`.** Version-locked by construction and
no third party involved. But it forgoes the discovery that comes with being in the directory
people already search, and users in that ecosystem would have had to learn a second command for
a job the first one does.

## Consequences

**We do not control the update policy, and it is not a gentle one.** `npx skills update`
overwrites an edited copy without warning — observed, not inferred: its lock file stores a hash
of what it installed, so it could detect the edit, and does not. The README says so where a user
meets it. Anything worth keeping belongs outside the skills directory.

**The unpinned form can install a skill ahead of the reader's CLI.** `metadata.requires` makes
that detectable rather than a command failing halfway through a setup. Detectable is not
detected: nothing in accreta reads an installed skill, so the comparison is the reader's to
make. Closing that gap — `accreta doctor` finding the installed copy and comparing floors — is
[#103](https://github.com/francescofioredev/accreta/issues/103). _Amended 2026-10-13: closed by
[#169](https://github.com/francescofioredev/accreta/pull/169); see the amendment below._

**A skill is instructions an agent will follow, fetched from a branch that moves.** That is the
same trust argument the README already makes about pages, and it now applies to the file that
drives the ingest. The in-package copy is the audited alternative, which is most of why it still
ships.

**If the channel decays, this is reversible.** The rejected installer is written down above, and
nothing else in the codebase depends on how the skill arrives.

## Amendment, 2026-10-13: `doctor` reads the installed skill

[#169](https://github.com/francescofioredev/accreta/pull/169) closed #103. `accreta doctor` has
a `skill` section that finds installed copies of `accreta-setup` and compares each one's
`metadata.requires` with the CLI's own version. The code is
`packages/cli/src/commands/skill-floor.ts`; `doctor.ts` prints the result.

**Where it looks.** Four directories, two in the project and two global:

- `.agents/skills/` and `.claude/skills/`, in the current directory and in each parent up to the
  repository root (the first directory holding `.git`). The walk stops before the home directory,
  which the global pair covers;
- `~/.agents/skills/`, and `~/.claude/skills/`, or `$CLAUDE_CONFIG_DIR/skills/` when that is set.

**Why those.** They are where `npx skills` 1.7.0 writes, and where the agents that read them look.
The skills CLI installs into the directory it runs in. A symlink install, and every agent it calls
universal, goes to `.agents/skills/`, or `~/.agents/skills/` with `-g`. A copy for Claude Code
alone goes to `.claude/skills/`. Claude Code and Codex load project skills from every directory up
to the repository root, so `doctor` walks the same path. This is a fixed list of directories, not
a table of agents, which this ADR rejected maintaining. A copy installed for one other agent, in
that agent's own directory, is not found. The PR measured nine installs with `npx skills@1.7.0
add` (project and `-g`; Claude Code, Cursor, Windsurf, mixed, `--copy`): seven found, and the two
Windsurf-only installs reported `unknown`.

**What it reports.** For each copy found, counted once even when a symlink and its target are
both on the path:

- `ok` when the CLI is at or above the floor;
- `stale` when the skill requires a later release, with the fix: upgrade accreta, or reinstall the
  skill pinned to this release's tag. `npx skills update` cannot help, since the skill is already
  ahead of the CLI;
- `unknown` when no copy is found, when a copy cannot be read (a dangling symlink, no `SKILL.md`,
  a permission error), when its frontmatter declares no release, or when a directory on the path
  could not be listed. A copy that cannot be read is reported as found, never as absent.

**It never fails.** The section never changes `doctor`'s exit code, `stale` included. The copy it
finds may not be the one the agent loads, and finding none proves nothing.

**When the skills CLI moves.** The list follows `npx skills` 1.7.0 and is not read from the CLI.
If a later release installs somewhere else, `doctor` does not find those copies. With none found
it reports `unknown`, and the exit code is unchanged. A copy left in a listed directory is still
reported, against its own floor. The fix is to add the new directory in `skill-floor.ts`.
Nothing else depends on it, so this stays as reversible as the rest of this ADR.
