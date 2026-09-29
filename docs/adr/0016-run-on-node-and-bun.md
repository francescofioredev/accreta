# ADR-0016: Run on Node 22.16+ and on Bun, with one SQLite seam

Status: accepted
Date: 2026-09-29

## Context

[ADR-0005](0005-ship-typescript-for-bun.md) shipped unbuilt TypeScript and required Bun. It
turned down a Node build because "nobody has asked for Node". The launch
([#109](https://github.com/francescofioredev/accreta/issues/109)) changes that. MCP setup for Cursor,
Codex and Claude usually assumes `npx`, which runs Node, and a Node user gets an error on the
first import.

Node cannot run the published packages as they are. Measured on Node v24.21.0: importing a `.ts`
entry point from `node_modules` fails with `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`. Node
strips types in your own code, not in dependencies.

The Bun-specific surface is small: `bun:sqlite` in `packages/core/src/index-db/db.ts`, and
`Bun.spawn` in the git adapter. The SQLite half is the one that matters, because the index
depends on four things from its driver: FTS5 with the `porter unicode61` tokenizer, WAL mode,
the prepared-statement API, and the stage-and-rename swap that
[ADR-0010](0010-readers-revalidate-by-inode.md) relies on.

### What was measured

[`0016-sqlite-probe.mjs`](0016-sqlite-probe.mjs) checks all four. It runs the real
`schema.sql` and mirrors `openIndex`, `sealForReading` and the swap in `build.ts`. The same file
runs under both runtimes: `node docs/adr/0016-sqlite-probe.mjs` uses `node:sqlite`, and
`bun docs/adr/0016-sqlite-probe.mjs` uses `bun:sqlite`. Node versions that were not installed
were run with `npx -y node@<version>`. **Everything here ran on macOS arm64 only.**

| Runtime            | SQLite | FTS5                        | Probe |
| ------------------ | ------ | --------------------------- | ----- |
| Node 22.14.0       | 3.47.2 | no: `no such module: fts5`  | 2/8   |
| Node 22.15.0, 22.15.1 | 3.49.1 | no                  | —     |
| Node 22.16.0       | 3.49.1 | yes                         | 8/8   |
| Node 22.18.0       | 3.50.2 | yes                         | —     |
| Node 22.23.3       | 3.51.3 | yes                         | 8/8   |
| Node 23.10.0       | 3.49.1 | no                          | —     |
| Node 24.21.0       | 3.53.4 | yes                         | 8/8   |
| Node 25.6.0, 25.9.0 | 3.51.2, 3.53.0 | yes                | —     |
| Bun 1.3.13         | 3.51.0 | yes                         | 8/8   |

A dash means only the FTS5 check was run. No Node version needed a flag. Every Node 22, 23 and 25
run printed `ExperimentalWarning: SQLite is an experimental feature` on stderr; Node 24.21.0 did
not.

On every version with FTS5, all four needs hold:

- **FTS5.** Porter stemming, diacritic folding (`cafe` finds `café`), the `aliases:` column
  filter, and the exact `snippet(...) … ORDER BY rank` query in `search.ts`.
- **WAL.** `PRAGMA journal_mode = WAL` returns `wal`. A read-only second connection reads the
  committed rows while another connection holds an open `BEGIN IMMEDIATE` write. Sealing leaves
  the file in `delete` mode, where a read-only connection reads and cannot write.
- **Statements.** `exec` of the whole multi-statement schema, `prepare`, `all`, `get`, `run`
  with `$`-prefixed named parameters, and `close` all exist. Integer columns come back as
  numbers. Three things differ from `bun:sqlite`; they are listed under Consequences.
- **The swap.** After a rebuild is renamed over the live file, `dev:ino` changes and a reopened
  reader sees the new rows.

Two more measurements rule out the single-driver options. Bun 1.3.13 has no `node:sqlite`
(`No such built-in module: node:sqlite`). `better-sqlite3` 13.0.3 works on Node 22.14.0 with
FTS5, and crashes Bun 1.3.13 outright with `panic: NAPI FATAL ERROR`.

## Decision

**Support Node 22.16 and later, and Bun 1.3.13 and later.** `engines` declares both:
`"node": ">=22.16"`. 22.16.0 is the first Node 22 release whose `node:sqlite` ships FTS5, and
without FTS5 there is no search.

**Use each runtime's built-in SQLite, behind one seam in `packages/core`.** `node:sqlite` under
Node, `bun:sqlite` under Bun. The seam is one module in `index-db/`. It picks the driver once,
when it loads, from `process.versions.bun`, and exports accreta's own narrow interface: open
(read-only or not), `exec`, `prepare` returning `all`/`get`/`run`, and `close`. Nothing outside
the seam imports either driver, and nothing outside it knows which runtime it is on. The
exported `Database` type becomes that interface, not `bun:sqlite`'s class.

**Callers use `prepare` and no statement cache.** `bun:sqlite`'s `db.query` is a cached
`prepare`, and `node:sqlite` has none. Preparing the search query took 4.2–4.6µs on Node and
3.8µs on Bun (mean of 10,000, from the probe). No query is prepared inside a per-row loop, so
a cache would save microseconds per tool call. It is not worth a cache's invalidation rules.

**Spawn git with `node:child_process`.** No seam is needed: `execFileSync("git", ["--version"])`
ran under both Node and Bun unchanged.

**Build with `tsc` to `dist/` using `rewriteRelativeImportExtensions`.** Sources keep their
`.ts` import specifiers, and the compiler rewrites them to `.js` on emit. Measured with the
repository's TypeScript 5.9.3 on `packages/core`: 13 JavaScript files, and all 21 relative
imports rewritten to `.js`. The emitted `.d.ts` files keep `.ts` specifiers. A `nodenext`
consumer with `skipLibCheck: false` still resolved them, and its only error was the missing
`bun:sqlite` types, which the seam keeps out of the exported types. `exports`, `bin` and
`types` point at `dist/`, and the bins carry `#!/usr/bin/env node`.

**Inside the repository, nothing changes for development.** Workspace packages export `src/`
under a custom `development` condition. Bun runs with `--conditions=development`, and
TypeScript sees the same condition through `customConditions`. Tests and benches keep running
the TypeScript directly, with no build step. Measured: `bun --conditions=development test`
resolved a package's `src.ts` and plain `bun test` resolved its `dist.js`.

## Alternatives rejected

**`better-sqlite3` on Node, `bun:sqlite` on Bun.** It would lower the Node floor to any Node 22,
since it bundles its own SQLite with FTS5. But it crashes Bun, so it could only ever be half of
a split, and the seam is needed anyway. What it adds is a native dependency: a prebuilt binary
per platform and Node ABI, and a compile from source where none matches. A built-in driver has none
of that.

**One `node:sqlite` driver everywhere.** No seam at all. Bun does not implement `node:sqlite`,
so this would drop Bun.

**A Node 24 floor.** Node 24 has FTS5 and printed no experimental warning. But Node 22 is still
a maintained LTS line, until April 2027. Requiring 24 would turn away users whose Node works,
to avoid a stderr line and a version check.

**Choosing the driver with `package.json` `imports` conditions** (`"#sqlite": {"bun": …,
"default": …}`). Measured to work: Bun took the `bun` branch and Node took `default`. It avoids
any runtime check, but the targets are file paths. Running from `src/` in the repository and
from `dist/` when installed then needs a second pair of mappings under the `development`
condition. One `process.versions.bun` check in one file is less to keep straight.

**Shipping `.ts` and letting Node strip types.** Node refuses inside `node_modules`, measured
above.

**A bundler** (`bun build`, esbuild, tsup). ADR-0005 turned this down for Bun, and the reason
still holds: stack traces should point at real files. A bundle also has to be told to leave
`bun:sqlite` and `node:sqlite` external, which is the seam again, described a second way.

**Rewriting every relative import to `.js` by hand**, then `tsc` without the rewrite. Bun
resolves `.js` specifiers to `.ts` files, so this would work. It touches every import in the
repository to get what one compiler option does at emit.

## Consequences

[#117](https://github.com/francescofioredev/accreta/issues/117) implements this, and has to
handle the following.

- **A version check up front.** `engines` is advisory, as ADR-0005 said. A user on Node
  22.13–22.15 would otherwise get `no such module: fts5` at the first reindex, which names
  neither Node nor a fix. The seam checks that FTS5 is present when it opens a database, and
  fails with a message naming Node 22.16. It checks the capability rather than parsing
  `process.version`, so a Node with FTS5 built in some other way still works. `doctor` reports
  the same check. On Node older than 22.13, `node:sqlite` itself will not load, and the seam
  turns that into the same message.
- **The experimental warning.** Node 22 prints it on stderr each time `node:sqlite` loads. It
  cannot corrupt MCP stdio or stdout output, but a CLI that warns on every command looks
  broken. Suppress that one warning, matched by type and message, before the driver loads, and
  nothing else.
- **Statement differences the seam smooths over:**
  - there is no `db.query`, so its 21 call sites move to `prepare`;
  - `.get()` returns `undefined` for no row where Bun returns `null`, so the seam returns
    `null` and callers see one behaviour;
  - rows have a null prototype under Node. Code that reads fields is unaffected, but anything
    that checks a row's prototype or uses `instanceof Object` is not.
- **The swap under Node on macOS.** A reader held across a rebuild behaved differently by
  runtime on the same Mac. Under Bun it threw `disk I/O error`, the macOS behaviour ADR-0010
  describes. Under Node it kept serving the old rows, the Linux behaviour: `node:sqlite` bundles
  its own SQLite, while Bun on macOS uses the system one. The loud failure is gone under Node
  even where accreta is developed. ADR-0010's inode check reopens in both cases, so the design
  holds. Its tests must keep asserting the reopen, never either platform's failure mode.
- **Build output.** `tsc` does not copy `schema.sql`. The build copies it into `dist/`, and the
  packing test keeps asserting it ships, for the reason ADR-0005 gives for `files`.
- **CI covers the second execution path.** ADR-0005's objection was that a Node path is worth
  nothing unless CI runs it. The unit suite stays on `bun test`. CI also runs the probe and the
  installed-tarball smoke test (`init`, `reindex`, a search) under Node 22.16, which is the
  floor, and under current Node.
- **Only macOS arm64 was measured.** Before this ships, CI runs the probe on Linux under both
  runtimes, because a hosted deployment runs there.
- **Still to check in #117:** how `bunx accreta` behaves with a `node` shebang on a machine that
  has Bun and no Node. `bunx --bun` forces Bun either way.

ADR-0005's decisions on assets copied at pack time, directory-form `files`, and `npm publish`
under trusted publishing still stand. This ADR replaces only its runtime and build decisions.
