# ADR-0005: Ship TypeScript, and require Bun

Status: accepted
Date: 2026-08-08

## Context

accreta had no distribution story. Every package was `private: true` at `0.0.0`, and
[#26](https://github.com/francescofioredev/accreta/issues/26) — an installer that places the
setup skill into a user's skills directory — was blocked behind the absence of anything to
install from.

The code is Bun-native and not incidentally so. `bun:sqlite` backs the index, `Bun.spawn` runs
git in the git adapter, the two binaries carry `#!/usr/bin/env bun`, and 55 imports name their
`.ts` extension because Bun resolves TypeScript directly. Publishing forces the question the
project had so far been able to leave open: which runtime is this for?

## Decision

**Ship the TypeScript sources unbuilt, and require Bun.** No bundler, no `dist/`, no compile
step in CI or at publish time. `bin` entries point at `src/main.ts`, `exports` at
`src/index.ts`, and `engines` declares `bun >= 1.3.13`.

**`engines` is advisory and the README says so.** Neither npm nor Bun enforces it. A Node user
who installs accreta gets a syntax error on the first `.ts` import, not a diagnostic. Stating
that plainly is better than a field that looks like a guarantee and is not one.

**Assets are copied into the package at pack time.** `templates/` and `skills/` live at the
repository root, where the documentation points and where people edit them; npm packs nothing
from outside a package directory. `prepack` copies them in, `postpack` removes them, and the
copies are gitignored so a second set cannot drift from the originals unnoticed. The resolver
looks in the packed location before the repository one, so a package that shipped without its
assets fails loudly instead of being rescued by a checkout that happens to be nearby.

**`files` entries are directory form, never globs.** `packages/core/src/schema.sql` is the one
non-TypeScript file core ships. `files: ["src/**/*.ts"]` would drop it and break every
`reindex` from an installed package, with nothing in the repository ever noticing.

## Alternatives rejected

**A Node-compatible build.** Swap `bun:sqlite` for `node:sqlite`, `Bun.spawn` for
`child_process`, bundle to `dist/`. This buys the larger audience, and it costs a build step, a
runtime abstraction the core does not currently need, and a second execution path that CI would
have to cover to be worth trusting. Nobody has asked for Node. The cost is real today and the
benefit is speculative, which is the wrong way round.

**Bundling for Bun anyway.** A build that concatenates sources without changing runtime. It
buys a smaller install and loses readable stack traces into the actual files, in exchange for a
toolchain to maintain. At this size that is not a trade worth making.

**Inlining the templates as TypeScript string constants**, as `commands.ts` already does for
the config scaffolds. It removes asset resolution entirely, and it turns a constitution meant
to be read and edited into a 7KB string literal. The templates are a product surface; they
should stay markdown.

**A long-lived npm token.** This was the original decision here, on the grounds that
[bun cannot do npm's OIDC exchange in Actions](https://github.com/oven-sh/bun/issues/22423) and
using `npm publish` would mean installing Node purely to publish. The first release attempt
made the cost concrete: a token without *Bypass two-factor authentication* sends `bun publish`
into an interactive browser login, and the job hangs on a prompt nobody can answer. Ticking
that box fixes it and is now a dead end — npm is
[withdrawing 2FA-bypass tokens](https://github.blog/changelog/2026-07-08-npm-install-time-security-and-gat-bypass2fa-deprecation/),
which lose sensitive-operation privileges in August 2026 and direct publishing in January 2027.

So the publish step runs `npm publish` under trusted publishing, and Node is installed in that
one workflow to do it. This contradicts the decision above and is worth stating plainly rather
than hiding: the repository is Bun, the publish step is not, because the registry's
authentication is not something the project gets to choose.

The concrete cost is that `npm publish` does not rewrite `workspace:*` the way `bun publish`
does — it copies the string into the tarball, and a package published that way cannot be
installed by anyone. Internal dependencies therefore name plain versions, and a test fails if
the protocol reappears. Verified that `npm pack` runs `prepack` and produces the same twelve
files as `bun pm pack`, so nothing about the package contents changes.

## Consequences

The CLI publishes as unscoped `accreta`; the libraries stay under `@accreta/*`. The root
package is renamed `accreta-monorepo` to free the name and stays private, as do the
cross-adapter test harness and the benchmark.

`v0.1.0` was already tagged and released before any of this existed, so the first published
version is `0.1.1`.

That first release had to be published by hand. A trusted publisher is configured per package
on a package's own settings page, and that page does not exist until the package does — so
there is no way to have OIDC in place for a first publish. The workflow takes over from the
second release onward, and the manual step is a one-off per new package rather than a standing
exception.

A test packs every publishable package, installs the tarballs outside the repository tree, and
runs `init --preset research` and `reindex` against them. Installing outside the tree is what
makes it a real test: inside it, the resolver's repository fallback would answer for a package
that shipped nothing and the suite would go green on a broken release.
