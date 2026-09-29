# ADR-0016: Run on Node 22.16+ and on Bun, with one SQLite seam

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

The Bun-specific surface is three things:

- `bun:sqlite` in `packages/core/src/index-db/db.ts`;
- `Bun.spawn` in the git adapter;
- `import.meta.main`, which guards all work in `packages/cli/src/main.ts` and
  `packages/mcp-server/src/main.ts`.

SQLite is the one with depth. The index depends on four things from its driver: FTS5 with the
`porter unicode61` tokenizer, WAL mode while a rebuild writes, the prepared-statement API, and
the stage-and-rename swap that [ADR-0010](0010-readers-revalidate-by-inode.md) relies on.

### What was measured

**Everything here ran on macOS arm64 only.** Linux and Windows are unmeasured. Node versions
that were not installed were run with `npx -y node@<version>`.

[`0016-sqlite-probe.mjs`](0016-sqlite-probe.mjs) checks the four needs. It runs the real
`schema.sql` and mirrors `openIndex`, `sealForReading` and the swap in `build.ts`, with its own
copy of the driver calls. Run it with `node` or `bun`. It shows what each runtime's SQLite can do.
It does not test the seam #117 will write, because it does not import it.

| Runtime               | SQLite         | FTS5                       | SQLite probe |
| --------------------- | -------------- | -------------------------- | ------------ |
| Node 22.14.0          | 3.47.2         | no: `no such module: fts5` | 2/8          |
| Node 22.15.0, 22.15.1 | 3.49.1         | no                         | —            |
| Node 22.16.0          | 3.49.1         | yes                        | 8/8          |
| Node 22.18.0          | 3.50.2         | yes                        | —            |
| Node 22.23.3          | 3.51.3         | yes                        | 8/8          |
| Node 23.10.0          | 3.49.1         | no                         | 2/8          |
| Node 24.21.0          | 3.53.4         | yes                        | 8/8          |
| Node 25.6.0, 25.9.0   | 3.51.2, 3.53.0 | yes                        | —            |
| Bun 1.3.13            | 3.51.0         | yes                        | 8/8          |

A dash means only the FTS5 check was run. No Node version needed a flag. Every Node 22, 23 and
25 run printed `ExperimentalWarning: SQLite is an experimental feature` on stderr; Node 24.21.0
did not.

On every version with FTS5, all four needs hold:

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

[`0016-runtime-probe.mjs`](0016-runtime-probe.mjs) records where the two runtimes differ. It
reports outcomes and asserts nothing. Results on Node 22.16.0, Node 24.21.0 and Bun 1.3.13:

| Case                                   | Node 22.16.0              | Node 24.21.0      | Bun 1.3.13                 |
| -------------------------------------- | ------------------------- | ----------------- | -------------------------- |
| `import.meta.main` in the entry module | `undefined`               | `true`            | `true`                     |
| bind `undefined`                       | throws                    | throws            | binds NULL                 |
| bind `true`                            | throws                    | binds 1           | binds 1                    |
| unknown named key (`$nope`)            | throws                    | throws            | ignored                    |
| `SELECT "text"` (double-quoted)        | throws `no such column`   | throws            | returns `'text'`           |
| INTEGER 2^53 + 1                       | throws                    | throws            | returns 2^53, rounded      |
| statement used after `close()`         | throws `finalized`        | throws            | still returns rows         |
| open with `{ readonly: true }`         | **ignored: writes succeed** | **ignored: writes succeed** | read-only          |
| open with `{ readOnly: true }`         | read-only                 | read-only         | throws `Misspelled option` |
| `execFileSync`, 2 MiB stdout           | throws `ENOBUFS`          | throws `ENOBUFS`  | throws `ENOBUFS`           |
| async `execFile`, `maxBuffer` 64 MiB   | 2,097,152 bytes           | same              | same                       |

`import.meta.main` was also `undefined` on Node 22.17.1 and 23.10.0, and `true` on 22.18.0 and
22.23.3. Binding `true` also threw on 22.23.3.

The script loads the driver the way the seam will: it installs the warning filter, then
`createRequire(import.meta.url)` loads `node:sqlite` or `bun:sqlite` synchronously. On 22.16.0
the filter caught one warning and nothing reached stderr.

Some results come from one-off commands, not from a script in the repository:

- **Type stripping.** A `node_modules/tspkg` whose `exports` is `./index.ts`, imported from an
  `.mjs` under Node 24.21.0, gave `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`.
- **`better-sqlite3` 13.0.3**, installed with `npm install better-sqlite3` in a scratch
  directory. Creating an fts5 table worked under Node 22.14.0. `bun` on the same file crashed
  with `panic: NAPI FATAL ERROR`.
- **Bun has no `node:sqlite`.** `bun -e 'await import("node:sqlite")'` gave `No such built-in
  module: node:sqlite`.
- **`imports` conditions.** A package with `"imports": {"#sqlite": {"bun": "./bun.js",
  "default": "./node.js"}}` loaded `bun.js` under `bun` and `node.js` under `node`.
- **Custom export condition.** A package exporting `{"@accreta/source": "./src.ts", "default":
  "./dist.js"}` resolved `src.ts` under `bun --conditions=@accreta/source test` and `dist.js`
  under plain `bun test`. The same held for a condition named `development`.
- **`bun:sqlite` options.** A database opened with `{ strict: true, safeIntegers: true }`
  accepted an unknown named key and a bound `undefined`, threw on a missing named key, returned
  `SELECT 9007199254740993` exactly as a bigint, and returned `SELECT "text"` as a string.
- **The shebang decides the runtime.** A bin with `#!/usr/bin/env node`, run with `bun run` and
  nvm's Node 22.14.0 first on `PATH`, ran under Node 22.14.0. `bun --bun run` ran it under Bun.
  The PR review measured the same with `bunx`, and found that `bun add -g` links bins straight
  to the script.
- **`tsc` 5.9.3 emit of `packages/core`** with `rewriteRelativeImportExtensions`: 13 JavaScript
  files, and all 21 relative imports rewritten to `.js`. The emitted `.d.ts` files keep `.ts`
  specifiers. A `nodenext` consumer with `skipLibCheck: false` resolved them, and its only error
  was the missing `bun:sqlite` types.

## Decision

**Support Node `^22.16.0 || >=24`, and Bun 1.3.13 and later.** 22.16.0 is the first Node 22
release whose `node:sqlite` ships FTS5, and without FTS5 there is no search. Node 23 is left out
because 23.10.0 has no FTS5.

**Use each runtime's built-in SQLite, behind one seam in `packages/core`.** `node:sqlite` under
Node, `bun:sqlite` under Bun. The seam is one module in `index-db/`. It chooses the driver once,
from `process.versions.bun`, and loads it with `createRequire(import.meta.url)`. That load is
synchronous, so opening an index stays synchronous. It also lets the warning filter be installed
before the driver loads. A static import cannot work, because each runtime fails on the other's
module. Nothing outside the seam imports either driver, and nothing outside it knows which
runtime it is on.

The seam exports accreta's own narrow interface: open (read-only or not), `exec`, `prepare`
returning `all`/`get`/`run`, and `close`. The exported `Database` type becomes that interface,
not `bun:sqlite`'s class.

**The seam behaves the same on both runtimes, and the stricter side sets the rule.** Where the
drivers differ, as in the table above, the seam makes Bun as strict as Node:

- it throws on binding `undefined`, and on a named key the statement does not have;
- it binds booleans as 1 and 0 on both runtimes, because Node 22 refuses them;
- it throws on an integer outside the safe range rather than rounding it;
- it throws when a statement is used after its database is closed;
- `.get()` returns `null` for no row, and rows are plain objects.

Most of this has to be done in the seam's own code. Bun's `strict: true` option rejected a
*missing* named key but accepted an unknown key and a bound `undefined`. `safeIntegers:
true` returns 2^53 + 1 exactly, as a bigint, so the seam can convert or throw.

Double-quoted string literals are the one gap. Node rejects them. Bun accepted `SELECT "text"`
even with `strict: true`, and `bun:sqlite` has no option to turn them off. The seam cannot make
Bun strict here without parsing SQL. Instead, CI runs the seam test and the smoke test under
Node, which fails on any such literal in accreta's queries.

**Callers use `prepare`, with no statement cache.** `bun:sqlite`'s `db.query` is a cached
`prepare`, and `node:sqlite` has none. Preparing the search query took 4.2–4.6µs on Node and
3.8µs on Bun (mean of 10,000, from the SQLite probe). `search_pages` also calls `getPage` for
each hit, which prepares one or two statements. At the 50-hit maximum that is at most 101
prepares, about 0.46 ms at 4.6µs each. That does not justify a cache and its invalidation
rules.

**Spawn git with async `execFile` from `node:child_process`, with an explicit `maxBuffer`.** It
behaves the same under both runtimes, so no seam is needed. `execFileSync` is rejected. Its
default 1 MiB buffer threw `ENOBUFS` on both runtimes, and it would block the MCP server while
git runs. Today's `Bun.spawn` helper is async and has no output cap, so the replacement keeps
both properties: async, and a buffer far above any real diff, or streaming. Failures still map
to `GitCommandError`.

**Bins get an entry file with no guard.** Each bin points at a small file that calls `run()`
directly. `main.ts` stops guarding on `import.meta.main`, which is `undefined` on Node 22.16 and
22.17. Under that guard, the PR review found that `npx accreta drift --strict` printed nothing and
exited 0 on those versions: a silent pass in CI, with the FTS5 check never run.

**The shebang is `#!/usr/bin/env node`, and it decides the runtime.** A Bun install runs the
bins under whatever Node is first on `PATH`, not under Bun. That covers `bunx`, `bun run` and a
bin linked by `bun add -g`. A Bun user with an old Node on `PATH` therefore gets that Node. The
FTS5 check's error names the way out, `bunx --bun accreta` or `bun --bun`, and Bun install
instructions use `--bun`.

**Build with `tsc` to `dist/` using `rewriteRelativeImportExtensions`.** Sources keep their
`.ts` import specifiers, and the compiler rewrites them to `.js` on emit. `exports`, `bin` and
`types` point at `dist/`. The `bun:sqlite` types stay out of the exported declarations.

**Inside the repository, tests and benches run from source.** Workspace packages export `src/`
under a condition unique to this project, `@accreta/source`, and Bun and TypeScript are told to
use it. Bun takes it as `--conditions=@accreta/source`, and TypeScript through
`customConditions`. A widely shared name like `development` is rejected, because Vite and
webpack set it in dev mode. A consumer's dev server would then resolve `src/`, which is not
published. The PR review found that the flag has to be passed on every invocation, since no
`bunfig.toml` spelling worked. `postpack` deletes `dist/`, so a stale build is never picked up by
a plain `bun test`, a bench or a CI step that forgot the flag.

## Alternatives rejected

**`better-sqlite3` on Node, `bun:sqlite` on Bun.** It would lower the Node floor to any Node 22,
since it bundles its own SQLite with FTS5. But it crashes Bun, so it could only ever be half of
a split, and the seam is needed anyway. What it adds is a native dependency: a prebuilt binary
per platform and Node ABI, and a compile from source where none matches. A built-in driver has
none of that.

**One `node:sqlite` driver everywhere.** No seam at all. Bun does not implement `node:sqlite`,
so this would drop Bun.

**A Node 24 floor.** Node 24 has FTS5, sets `import.meta.main`, and printed no experimental
warning. But Node 22 is still a maintained LTS line, until April 2027. Requiring 24 would turn
away users whose Node works, to avoid a stderr line, a guard-free entry file and a version
check.

**Choosing the driver with `package.json` `imports` conditions** (`"#sqlite": {"bun": …,
"default": …}`). It worked when measured, and it avoids any runtime check, but the targets are
file paths. Running from `src/` in the repository and from `dist/` when installed then needs a
second pair of mappings under the source condition. One `process.versions.bun` check in one
file is less to keep straight.

**Shipping `.ts` and letting Node strip types.** Node refuses inside `node_modules`, measured
above.

**A bundler** (`bun build`, esbuild, tsup). ADR-0005 turned this down for Bun, and the reason
still holds: stack traces should point at real files. A bundle also has to be told to leave
`bun:sqlite` and `node:sqlite` external, which is the seam again, described a second way.

**Rewriting every relative import to `.js` by hand**, then `tsc` without the rewrite. Bun
resolves `.js` specifiers to `.ts` files, so this would work. It touches every import in the
repository to get what one compiler option does at emit.

**A `bun` shebang, or one bin per runtime.** A `bun` shebang breaks every Node user, which is
the audience this ADR exists for. Two bins double what every install guide has to explain.

## Consequences

[#117](https://github.com/francescofioredev/accreta/issues/117) implements this, and has to
handle the following.

- **A version check up front.** `engines` is advisory, as ADR-0005 said. A user on Node
  22.13–22.15 or 23 would otherwise get `no such module: fts5` at the first reindex, which names
  neither Node nor a fix. The seam checks that FTS5 is present when it opens a database, and
  fails with a message that names Node 22.16 and `bunx --bun accreta`. It checks the capability
  rather than parsing `process.version`, so a Node with FTS5 built in some other way still
  works. `doctor` reports the same check. On Node older than 22.13, `node:sqlite` itself will not
  load, and the seam turns that into the same message.
- **The experimental warning.** Node 22 prints it on stderr each time `node:sqlite` loads. It
  cannot corrupt MCP stdio or stdout output, but a CLI that warns on every command looks
  broken. Filter that one warning, matched by message, before the driver loads, and nothing
  else.
- **Statement call sites.** `db.query` becomes `prepare`: 16 call sites in `packages/*/src` and
  23 in the tests on `main`, counted with `grep -rE '\.query\('`.
- **One seam test, run under both runtimes.** It covers every row of the runtime table: the
  binding rules, large integers, use after close, `get` returning `null`, and plain-object
  rows. Under Node it also covers double-quoted literals. It also runs under Node against the real seam and asserts that
  a write through the read-only open is refused. Passing Bun's spelling to `node:sqlite` is
  silently ignored and leaves the MCP reader writable, and the SQLite probe would not notice.
  The probe is not coverage of the Node path.
- **The held reader across a swap.** On the same Mac, a reader held across a rebuild threw
  `disk I/O error` under Bun and kept serving the old rows under Node. The difference is the
  SQLite build, not the operating system. Bun on macOS uses Apple's system SQLite, and the PR
  review measured Bun against Homebrew's SQLite 3.53 serving stale rows, as Node does. ADR-0010's
  inode check reopens in both cases, so the design holds, and its tests must keep asserting the
  reopen, never either failure mode. The comments that say "macOS fails" should say "Apple's
  SQLite fails": ADR-0010's Context, `build.ts` near the staging comment, `context.ts` in the MCP
  server, and the swap test in `build.test.ts`. That rewording belongs to #117, not this ADR.
- **Git output.** A test runs the adapter against a diff over 1 MiB.
- **Bins.** Each bin gets a guard-free entry file. The installed-tarball smoke test asserts the
  commands did something: an index file exists after `reindex`, and a search returns a hit.
  Exit 0 alone proved nothing on Node 22.16.
- **Source condition.** A test asserts that `@accreta/core` resolves to `src/` inside the
  repository.
- **Build output.** `tsc` does not copy `schema.sql`. The build copies it into `dist/`, and the
  packing test keeps asserting it ships, for the reason ADR-0005 gives for `files`.
- **CI covers the second execution path.** ADR-0005's objection was that a Node path is worth
  nothing unless CI runs it. The unit suite stays on `bun test`. CI also runs the seam test and
  the installed-tarball smoke test under Node 22.16, which is the floor, and under current Node.
- **Only macOS arm64 was measured.** CI runs both probes on Linux under both runtimes before
  this ships, because a hosted deployment runs there. Windows is unmeasured and unsupported
  until someone measures it. Renaming over an open index may fail there with `EPERM`, which
  would break ADR-0010's swap.
- **README follow-up.** `README.md` is frozen until the launch lane
  ([#141](https://github.com/francescofioredev/accreta/issues/141)). When it is next edited, its
  install section states the Node range, and gives `bunx --bun accreta` for Bun.

ADR-0005's decisions on assets copied at pack time, directory-form `files`, and `npm publish`
under trusted publishing still stand. This ADR replaces only its runtime and build decisions.
