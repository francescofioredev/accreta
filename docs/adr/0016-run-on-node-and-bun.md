# ADR-0016: Run on Node 22.16+ and Bun 1.4+, with `node:sqlite` on both

Status: accepted
Date: 2026-09-29

## Context

[ADR-0005](0005-ship-typescript-for-bun.md) shipped unbuilt TypeScript and required Bun. It
turned down a Node build because "nobody has asked for Node". The launch
([#109](https://github.com/francescofioredev/accreta/issues/109)) changes that. MCP setup for
Cursor, Codex and Claude usually assumes `npx`, which runs Node, and a Node user gets an error on
the first import.

Node cannot run the published packages as they are. Measured on Node v24.21.0: importing a `.ts`
entry point from `node_modules` fails with `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`. Node
strips types in your own code, not in dependencies.

Three things in the code are specific to Bun:

- `bun:sqlite` in `packages/core/src/index-db/db.ts`;
- `Bun.spawn` in the git adapter;
- `import.meta.main`, which guards all work in `packages/cli/src/main.ts` and
  `packages/mcp-server/src/main.ts`.

SQLite is the one with depth. The index depends on four things from its driver:

- FTS5 with the `porter unicode61` tokenizer;
- WAL mode while a rebuild writes;
- the prepared-statement API;
- the stage-and-rename swap that [ADR-0010](0010-readers-revalidate-by-inode.md) relies on.

### What was measured

**Everything here ran on macOS arm64 only.** Linux and Windows are unmeasured. Versions that
were not installed were run with `npx -y node@<version>` or `npx -y bun@<version>`.

[`0016-sqlite-probe.mjs`](0016-sqlite-probe.mjs) checks the four needs. It runs the real
`schema.sql` and mirrors `openIndex`, `sealForReading` and the swap in `build.ts`, with its own
copy of the driver calls. Run it with `node` or `bun`. It uses `node:sqlite` on both, and
`--driver=bun` switches it to `bun:sqlite`. It shows what each runtime's SQLite can do. It does
not test accreta's own `db.ts`.

| Runtime               | Driver        | SQLite         | FTS5                       | SQLite probe |
| --------------------- | ------------- | -------------- | -------------------------- | ------------ |
| Node 22.14.0          | `node:sqlite` | 3.47.2         | no: `no such module: fts5` | 2/8          |
| Node 22.15.0, 22.15.1 | `node:sqlite` | 3.49.1         | no                         | —            |
| Node 22.16.0          | `node:sqlite` | 3.49.1         | yes                        | 8/8          |
| Node 22.18.0          | `node:sqlite` | 3.50.2         | yes                        | —            |
| Node 22.23.3          | `node:sqlite` | 3.51.3         | yes                        | 8/8          |
| Node 23.10.0          | `node:sqlite` | 3.49.1         | no                         | 2/8          |
| Node 24.21.0          | `node:sqlite` | 3.53.4         | yes                        | 8/8          |
| Node 25.6.0, 25.9.0   | `node:sqlite` | 3.51.2, 3.53.0 | yes                        | —            |
| Bun 1.3.13            | `bun:sqlite`  | 3.51.0         | yes                        | 8/8          |
| Bun 1.3.13, 1.3.14    | `node:sqlite` | —              | —                          | does not load |
| Bun 1.4.0             | `node:sqlite` | 3.51.0         | yes                        | 8/8          |
| Bun 1.4.2             | `node:sqlite` | 3.51.0         | yes                        | 8/8          |

A dash in the probe column means only the FTS5 check was run.

On Bun 1.3.13 and 1.3.14, loading the module fails with `No such built-in module: node:sqlite`.
Bun 1.4.0 was published to npm on 2026-08-20.

No Node version needed a flag. Every Node 22, 23 and 25 run printed `ExperimentalWarning: SQLite
is an experimental feature` on stderr. Node 24.21.0, Bun 1.4.0 and Bun 1.4.2 printed nothing.

On every runtime with FTS5, all four needs hold:

- **FTS5.** Porter stemming, diacritic folding (`cafe` finds `café`), the `aliases:` column
  filter, and the exact `snippet(...) … ORDER BY rank` query in `search.ts`.
- **WAL.** `PRAGMA journal_mode = WAL` returns `wal`. Sealing leaves the file in `delete` mode,
  where a read-only connection reads and cannot write. The probe also shows a second connection
  reading during an open write. accreta never does that, so the check is informational.
- **Statements.** `exec` of the whole multi-statement schema, `prepare`, `all`, `get`, `run`
  with `$`-prefixed named parameters, and `close` all exist. Integer columns come back as
  numbers.
- **The swap.** After a rebuild is renamed over the live file, `dev:ino` changes and a reopened
  reader sees the new rows.

[`0016-runtime-probe.mjs`](0016-runtime-probe.mjs) records the behaviour code has to know about.
It reports outcomes and asserts nothing. The same run gave the same result on Bun 1.4.0 and
1.4.2. The last column is `--driver=bun` on Bun 1.3.13, the driver this ADR moves away from.

| Case                                   | Node 22.16.0              | Node 24.21.0      | Bun 1.4.x, `node:sqlite`  | Bun 1.3.13, `bun:sqlite`   |
| -------------------------------------- | ------------------------- | ----------------- | ------------------------- | -------------------------- |
| `import.meta.main` in the entry module | `undefined`               | `true`            | `true`                    | `true`                     |
| bind `undefined`                       | throws                    | throws            | throws                    | binds NULL                 |
| bind `true`                            | throws                    | binds 1           | throws                    | binds 1                    |
| unknown named key (`$nope`)            | throws                    | throws            | throws                    | ignored                    |
| `SELECT "text"` (double-quoted)        | throws `no such column`   | throws            | throws `no such column`   | returns `'text'`           |
| INTEGER 2^53 + 1                       | throws                    | throws            | throws                    | returns 2^53, rounded      |
| statement used after `close()`         | throws `finalized`        | throws            | throws `finalized`        | still returns rows         |
| open with `{ readonly: true }`         | ignored: writes succeed   | ignored           | ignored: writes succeed   | read-only                  |
| open with `{ readOnly: true }`         | read-only                 | read-only         | read-only                 | throws `Misspelled option` |
| `execFileSync`, 2 MiB stdout           | throws `ENOBUFS`          | throws `ENOBUFS`  | throws `ENOBUFS`          | throws `ENOBUFS`           |
| async `execFile`, `maxBuffer` 64 MiB   | 2,097,152 bytes           | same              | same                      | same                       |

`import.meta.main` was also `undefined` on Node 22.17.1 and 23.10.0, and `true` on 22.18.0 and
22.23.3. Binding `true` also threw on Node 22.23.3.

Under Bun 1.4, `node:sqlite` matches Node on every row that matters. There is one driver and one
set of rules. The last column is what a two-driver design would have had to make match, and
the double-quoted literal could not have been.

[`0016-entry/`](0016-entry/) reproduces the bin entry shape. Run `node` or `bun` on
`entry.mjs` or on `static-entry.mjs`. The directory has four modules:

- `support.mjs` holds the warning filter and the unsupported-runtime message, and has no import
  path to `node:sqlite`;
- `program.mjs` stands in for the CLI: it imports `node:sqlite` statically and checks for FTS5;
- `entry.mjs` imports `support.mjs`, then loads `program.mjs` with `await import(...)`;
- `static-entry.mjs` imports both statically, filter first.

| Runtime                | `entry.mjs`                                    | `static-entry.mjs`                                    |
| ---------------------- | ---------------------------------------------- | ----------------------------------------------------- |
| Node 22.16.0           | runs; 1 warning filtered; stderr empty         | runs; 0 filtered; the warning reaches stderr          |
| Node 22.23.3           | runs; 1 warning filtered                       | —                                                     |
| Node 24.21.0           | runs; no warning to filter                     | —                                                     |
| Bun 1.4.0              | runs; no warning to filter                     | runs                                                  |
| Bun 1.4.2              | runs; no warning to filter                     | —                                                     |
| Node 22.14.0 (no FTS5) | prints the message, exit 1                     | —                                                     |
| Node 22.12.0           | prints the message, exit 1                     | —                                                     |
| Bun 1.3.13, 1.3.14     | prints the message, exit 1                     | uncaught `No such built-in module`, message never shown (1.3.13) |

Node 22.12.0 runs `node:sqlite` only behind a flag, so its import failed like Bun 1.3's.

So a static import works on every supported runtime. On Node 22, though, the warning fires when
`node:sqlite` is linked, before any module code runs, so a filter imported on the line above
catches nothing. The PR review also measured that `ERR_UNKNOWN_BUILTIN_MODULE` is catchable
around `await import()` on Bun 1.3.13, Node 22.12 and Node 20.18.

Some results come from one-off commands, not from a script in the repository:

- **Null-prototype rows compare equal.** Under `bun test` on Bun 1.4.2, a `node:sqlite` row
  passed both `toEqual({ n: 1 })` and `toStrictEqual({ n: 1 })`.
- **The held reader on macOS.** Under Bun 1.4.2, the SQLite probe's held reader threw `disk
  I/O error`, as it did with `bun:sqlite`. On macOS, Bun loads the system SQLite (3.51.0 on
  both), and Apple's SQLite is what fails that connection. Node bundles its own SQLite, and
  there the held reader kept serving the old rows. The PR review also measured Bun against
  Homebrew's SQLite 3.53 serving stale rows. The difference is the SQLite build, not the
  operating system.
- **Type stripping.** A `node_modules/tspkg` whose `exports` is `./index.ts`, imported from an
  `.mjs` under Node 24.21.0, gave `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`.
- **`better-sqlite3` 13.0.3**, installed with `npm install better-sqlite3` in a scratch
  directory. Creating an fts5 table worked under Node 22.14.0. Bun 1.3.13 on the same file
  crashed with `panic: NAPI FATAL ERROR`.
- **Custom export condition.** A package exporting `{"@accreta/source": "./src.ts", "default":
  "./dist.js"}` resolved `src.ts` under `bun --conditions=@accreta/source test` and `dist.js`
  under plain `bun test`.
- **The shebang decides the runtime.** A bin with `#!/usr/bin/env node`, run with `bun run` and
  nvm's Node 22.14.0 first on `PATH`, ran under Node 22.14.0. `bun --bun run` ran it under Bun.
- **No Node on `PATH`.** With `PATH=/usr/bin:/bin`, executing that bin directly failed with
  `env: node: No such file or directory`, exit 127, before any of its code ran. That is how a
  bin linked by `bun add -g` is executed. `bun run` on the same bin fell back to Bun. The PR
  review measured the same with `bunx`, and found that `bun add -g` links bins straight to the
  script.
- **`tsc` 5.9.3 emit of `packages/core`** with `rewriteRelativeImportExtensions`: 13 JavaScript
  files, and all 21 relative imports rewritten to `.js`. The emitted `.d.ts` files keep `.ts`
  specifiers. A `nodenext` consumer with `skipLibCheck: false` resolved them, and its only error
  was the missing `bun:sqlite` types, which this decision removes.

## Decision

**Support Node `^22.16.0 || >=24`, and Bun `>=1.4.0`.**

- 22.16.0 is the first Node 22 release whose `node:sqlite` ships FTS5, and without FTS5 there
  is no search.
- Node 23 is left out because 23.10.0 has no FTS5.
- Bun 1.4.0 is the first Bun with `node:sqlite`.

**Use `node:sqlite` on both runtimes, imported statically.** `db.ts` imports `DatabaseSync` from
`node:sqlite`, and `bun:sqlite` leaves the codebase. There is no second driver, no runtime check
and no strictness code: both runtimes already refuse the same things, as the table above shows.

What is left of the seam is `db.ts` itself, and it keeps two jobs:

- **Opening.** It is the one place that opens a database, and so the one place that spells
  `readOnly`. Bun's old spelling, `readonly`, is silently ignored by `node:sqlite` and leaves a
  reader writable.
- **The FTS5 check.** It checks for FTS5 when it opens a database. If FTS5 is missing it fails
  with a message naming the supported range, not with `no such module: fts5`.

The exported `Database` type becomes `node:sqlite`'s `DatabaseSync`, or a narrow interface over
it.

**Callers use `prepare`, with no statement cache.** `bun:sqlite`'s `db.query` was a cached
`prepare`, and `node:sqlite` has none. Preparing the search query took 4.2–4.6µs on Node, 4.9µs
on Bun 1.4.2 and 3.8µs on Bun 1.3.13 with `bun:sqlite` (mean of 10,000, from the SQLite probe).
`search_pages` also calls `getPage` for each hit, which prepares one or two statements. At the
50-hit maximum that is at most 101 prepares, about 0.5 ms. That does not justify a cache and its
invalidation rules.

**Code is written for `node:sqlite`'s behaviour, not normalized.**

- `.get()` returns `undefined` for no row, and the source call sites already test only for
  truthiness.
- Rows have a null prototype, which `bun test` equality accepts.
- Booleans are never bound. Node 22 and Bun 1.4 refuse them, while Node 24 binds them.

**Spawn git with async `execFile` from `node:child_process`, with an explicit `maxBuffer`.**
`execFileSync` is rejected: its default 1 MiB buffer threw `ENOBUFS` on every runtime, and it
would block the MCP server while git runs. Today's `Bun.spawn` helper is async and has no output
cap, so the replacement keeps both: async, and a buffer far above any real diff, or streaming.
Failures still map to `GitCommandError`.

**Each bin gets an entry file, and nothing is guarded by `import.meta.main`.** The entry file
does three things, in this order:

1. It installs the filter for the one SQLite experimental warning.
2. It loads the rest of the program with `await import(...)`. Loading it this way is what lets
   the filter run first on Node 22.
3. It calls `run()`.

If the dynamic import fails because `node:sqlite` is missing (Node before 22.13, or Bun before
1.4), the entry file prints the same message as the FTS5 check.

**The entry file has no static import path to `node:sqlite`.** The entry file, the warning
filter and the message text live in a module that imports nothing that reaches `db.ts`.
`@accreta/core`'s barrel re-exports `db.ts`, so importing the filter or the message from
`@accreta/core` would link `node:sqlite` before the entry file runs. On Bun 1.3.13 that gave an
uncaught `No such built-in module`, exit 1, and no message (`static-entry.mjs` above). On Node
22.16 the filter caught nothing. The module can live in its own subpath export, or be
duplicated per bin. Either way it is not the barrel.

**Every unsupported-runtime path exits non-zero.** The message goes to stderr, and the process
exits 1, whether the import failed or FTS5 is missing. Otherwise `drift --strict` in CI could
pass on a runtime that never ran it.

`main.ts` loses its guard. `import.meta.main` is `undefined` on Node 22.16 and 22.17, and the PR
review found that `npx accreta drift --strict` then printed nothing and exited 0. That is a
silent pass in CI, with the FTS5 check never run.

**The shebang is `#!/usr/bin/env node`, and it decides the runtime.** A Bun install runs the
bins under whatever Node is first on `PATH`. That covers `bunx`, `bun run` and a bin linked by
`bun add -g`.

- A Bun user with an older Node on `PATH` gets that Node, and the version message names the
  way out: `bunx --bun accreta`, or `bun --bun`.
- A bin installed with `bun add -g` needs Node on `PATH`. Without it the shell fails with exit
  127 before accreta can say anything.
- Bun-only users run accreta with `bunx --bun accreta` or `bun --bun`, and Bun install
  instructions say so.

**Build with `tsc` to `dist/` using `rewriteRelativeImportExtensions`.** Sources keep their
`.ts` import specifiers, and the compiler rewrites them to `.js` on emit. `exports`, `bin` and
`types` point at `dist/`.

**Inside the repository, tests and benches run from source.** Workspace packages export `src/`
under a condition unique to this project, `@accreta/source`. Bun takes it as
`--conditions=@accreta/source`, and TypeScript through `customConditions`.

- A widely shared name like `development` is rejected, because Vite and webpack set it in dev
  mode. A consumer's dev server would then resolve `src/`, which is not published.
- The PR review found that the flag has to be passed on every invocation, since no
  `bunfig.toml` spelling worked.
- `postpack` deletes `dist/`, so a stale build is never picked up by a plain `bun test`, a bench
  or a CI step that forgot the flag.

## Alternatives rejected

**Two drivers behind one seam: `node:sqlite` on Node, `bun:sqlite` on Bun.** This was this ADR's
first decision. It keeps Bun 1.3.x, and that is its whole advantage. It costs the following:

- The seam has to load the driver without a static import, because each runtime fails on the
  other's module. `createRequire` worked, measured with an earlier revision of the runtime probe
  in this PR.
- The seam needs its own strictness code to make `bun:sqlite` behave like `node:sqlite` on
  `undefined`, unknown keys, large integers and use after close. Bun's `strict: true` rejected
  a missing named key but still accepted an unknown key and a bound `undefined`.
- It leaves one gap that code cannot close. `bun:sqlite` accepts double-quoted string literals
  and has no option to refuse them, so only a CI run under Node would catch one.
- It needs two driver paths in every test.

Bun 1.4 removes all of that. Choosing the driver with `package.json` `imports` conditions was
considered within this option and goes with it.

**`better-sqlite3` on Node.** It would lower the Node floor to any Node 22, since it bundles its
own SQLite with FTS5. But it crashed Bun 1.3.13, so it would have been half of a split. Its cost
is a native dependency: a prebuilt binary per platform and Node ABI, and a compile from source
where none matches. The built-in driver has none of that.

**`bun:sqlite` everywhere.** Node has no `bun:sqlite`.

**A Node 24 floor.** Node 24 has FTS5, sets `import.meta.main`, and printed no experimental
warning. But Node 22 is still a maintained LTS line, until April 2027. Requiring 24 would turn
away users whose Node works, to avoid a warning filter, a guard-free entry file and a version
check.

**Shipping `.ts` and letting Node strip types.** Node refuses inside `node_modules`, measured
above.

**A bundler** (`bun build`, esbuild, tsup). ADR-0005 turned this down for Bun, and the reason
still holds: stack traces should point at real files.

**Rewriting every relative import to `.js` by hand**, then `tsc` without the rewrite. Bun
resolves `.js` specifiers to `.ts` files, so this would work. It touches every import in the
repository to get what one compiler option does at emit.

**A `bun` shebang, or one bin per runtime.** A `bun` shebang breaks every Node user, which is
the audience this ADR exists for. Two bins double what every install guide has to explain.

## Consequences

Most of this is [#117](https://github.com/francescofioredev/accreta/issues/117). Where another
issue or lane owns a file, it is named. This ADR edits none of those files.

- **Bun 1.4 everywhere Bun runs.** CI moves off Bun 1.3.13 to 1.4.0 and to the current 1.4
  ([#118](https://github.com/francescofioredev/accreta/issues/118); this lane owns
  `.github/workflows/`). So do contributors' machines and `bun.lock`. The root tsconfig loads
  only the `bun` types today, so #117 checks that `node:sqlite`'s types resolve under it.
- **The version message.** `engines` is advisory, as ADR-0005 said. Without a check, a user on
  Node 22.13–22.15 or 23 gets `no such module: fts5` at the first reindex, and a user on Bun
  1.3 gets `No such built-in module`. Neither names a fix. The message names Node
  `^22.16.0 || >=24`, Bun 1.4, and `bunx --bun accreta`. It checks the capability rather than
  parsing version strings. It goes to stderr with exit 1. `doctor` reports the same check.
- **Library users on Node 22 see the warning.** Code that imports `@accreta/core` directly,
  rather than through a bin, gets Node 22's experimental warning on stderr. This is accepted. A
  library that patches `process.emitWarning` on import would change its host's process behind
  its back. Node 24 does not print the warning at all.
- **Statement call sites.** `db.query` becomes `prepare`: 16 call sites in `packages/*/src` and
  23 in the tests on `main`, counted with `grep -rE '\.query\('`. Tests that assert `null` from
  `.get()` change to `undefined`.
- **A read-only test against the real `db.ts`.** It runs under both runtimes and asserts that a
  write through the read-only open is refused. The probes copy the driver calls, so they are not
  coverage of `db.ts`.
- **The held reader across a swap.** On macOS, Bun uses Apple's SQLite, and a held reader fails
  with `disk I/O error`. Node's bundled SQLite serves stale rows. ADR-0010's inode check reopens
  in both cases, so the design holds. Its tests must keep asserting the reopen, never either
  failure mode.
  - The comments that say "macOS fails" should say "Apple's SQLite fails": ADR-0010's Context,
    the staging comment in `build.ts`, `context.ts` in the MCP server, and the swap test in
    `build.test.ts`.
- **Git output.** A test runs the adapter against a diff over 1 MiB.
- **Every direct invocation of `src/main.ts` moves to the entry file.** Once the guard is gone
  from `main.ts`, running it directly does nothing and exits 0. Current invocations, and who
  owns them:
  - the demo gate in `.github/workflows/ci.yml`, which also starts asserting on `lint`'s output
    rather than its exit code (#118);
  - the demo commands in `README.md`, which is frozen until the launch lane
    ([#141](https://github.com/francescofioredev/accreta/issues/141));
  - `examples/climate/README.md`;
  - `bench/jev/tasks/ingest-got.ts`, which runs `bun <cli>/src/main.ts init`, and which the
    evidence lane owns (`bench/`).
- **Existing MCP configs break on upgrade.** The setup skill, the MCP server's README and
  `examples/.mcp.json` all write `args: ["run", "node_modules/@accreta/mcp-server/src/main.ts"]`.
  That path no longer ships.
  - They move to `accreta mcp` (PR
    [#167](https://github.com/francescofioredev/accreta/pull/167)), and the release notes carry
    an upgrade note.
  - `doctor` currently reports ok when `.mcp.json` merely names accreta's server. It has to check
    the configured command as well
    ([#121](https://github.com/francescofioredev/accreta/issues/121)). The skill and its example
    belong to the surfaces lane.
- **The packaging test runs each installed bin under both runtimes.** Spawning `.bin/accreta`
  directly obeys the shebang, so the Bun job was really testing the runner's Node.
  - Each bin runs under `node` and under `bun --bun`.
  - The CLI's check asserts that the commands did something: an index file exists after
    `reindex`, and a search returns a hit. Exit 0 alone proved nothing on Node 22.16.
  - The MCP server's check includes an MCP `initialize` and `tools/list`.
  - Each bin also runs once on a runtime without `node:sqlite` (Node 22.12 or Bun 1.3.14), and
    once on a runtime without FTS5 (Node 22.14). Both assert the message and a non-zero exit.
  - On Node 22.16, stderr is asserted empty, which proves the warning filter ran first.
- **Source condition.** A test asserts that `@accreta/core` resolves to `src/` inside the
  repository.
- **Build output.** `tsc` does not copy `schema.sql`. The build copies it into `dist/`, and the
  packing test keeps asserting it ships, for the reason ADR-0005 gives for `files`.
- **CI covers both runtimes at both ends of the range.** ADR-0005's objection was that a second
  execution path is worth nothing unless CI runs it. CI runs the unit suite under Bun, and the
  `db.ts` test and the packaging test under Node 22.16, current Node, Bun 1.4.0 and current Bun
  (#118).
- **Only macOS arm64 was measured.** CI runs both probes on Linux under both runtimes before
  this ships, because a hosted deployment runs there. Windows is unmeasured and unsupported
  until someone measures it. Renaming over an open index may fail there with `EPERM`, which
  would break ADR-0010's swap.
- **README follow-up.** When the launch lane edits `README.md`, its install section states the
  Node and Bun ranges. It gives `bunx --bun accreta` for Bun, and says a `bun add -g` install
  needs Node on `PATH`.

ADR-0005's decisions on assets copied at pack time, directory-form `files`, and `npm publish`
under trusted publishing still stand. This ADR replaces only its runtime and build decisions.
