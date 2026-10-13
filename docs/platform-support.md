# Platform support

accreta runs on Node `^22.16.0 || >=24` and Bun `>=1.4.0`, on Linux and macOS
([ADR-0016](adr/0016-run-on-node-and-bun.md)). Windows is not supported yet.

## What CI runs

The `runtimes` job in [`ci.yml`](../.github/workflows/ci.yml) runs each operating system against
both ends of the supported range:

| Runner           | Node    | Bun    | Gates merges |
| ---------------- | ------- | ------ | ------------ |
| `ubuntu-latest`  | 22.16.0 | 1.4.0  | yes          |
| `ubuntu-latest`  | 24      | latest | yes          |
| `macos-latest`   | 22.16.0 | 1.4.0  | yes          |
| `macos-latest`   | 24      | latest | yes          |
| `ubuntu-latest`  | 26      | latest | yes          |
| `macos-latest`   | 26      | latest | yes          |
| `windows-latest` | 22.16.0 | 1.4.0  | no           |
| `windows-latest` | 24      | latest | no           |

Each cell runs:

- the two ADR-0016 probes under Node and under Bun;
- the whole test suite, the packaging test included. The packaging test packs the workspace,
  installs it into a fresh project, and runs each installed bin under `node` and `bun --bun`;
- the refusal checks, against official nodejs.org builds of Node 22.12.0 (no `node:sqlite`) and
  22.14.0 (no FTS5). Each build is checked against its `SHASUMS256.txt`, which is pinned by hash.

The `runtime matrix` check passes only when every Linux and macOS cell passed.

The two ends of the range are paired, oldest with oldest and current with current. Node 24 is
the current LTS line, and Node 26 the newest line that `>=24` admits. The test suite always runs
under Bun, so the Node version only reaches the probes and the installed bins.

## Linux and macOS

All six cells pass. One difference shows in the SQLite probe. On macOS, Bun loads Apple's
SQLite (3.51.0), and a reader held across the index swap fails with `disk I/O error`. On Linux,
Bun bundles its own SQLite (3.53.2 in Bun 1.4.0, 3.53.4 in 1.4.3), and the held reader serves the old rows, as it does under Node on both
systems. [ADR-0010](adr/0010-readers-revalidate-by-inode.md)'s inode check reopens the reader in
both cases.

## Windows

Windows runs with `continue-on-error`, so its result does not block a merge. Measured on
2026-10-13 in [run 38398640060](https://github.com/francescofioredev/accreta/actions/runs/38398640060):

- The install, and the fetch and checksum of the refused Node builds, work.
- The SQLite probe exits 1 at cleanup, because a connection still holds a file it tries to
  delete. It exits before it prints, so its results on Windows are unknown.
- The suite runs 736 tests: 365 pass and 365 fail on Node 22.16.0 and Bun 1.4.0, and 373 pass
  and 357 fail on Node 24 and Bun 1.4.3. On Linux and macOS it runs 871.

Of the 357 failures in the Node 24 cell:

- **318: `EBUSY` or `EPERM` on an open file.** Windows does not delete a file while a handle is
  open on it.
  - In 223 of them the index build itself fails, so `accreta reindex` fails on Windows. The
    cleanup in `buildIndex` throws `EBUSY` on the staging file and hides whatever failed first.
    ADR-0016 expected trouble here: renaming over an open index may fail on Windows, and
    ADR-0010's swap depends on that rename
    ([#287](https://github.com/francescofioredev/accreta/issues/287)).
  - The rest come from test cleanup, which removes a temp dir while a connection is still open
    ([#288](https://github.com/francescofioredev/accreta/issues/288)).
- **9: the packaging test runs `node_modules/.bin/accreta` as a script.** On Windows that path is
  a shim, not the script, so Node reports `Cannot find module` (#288).
- **6: Git on Windows warns that LF will become CRLF.** A test helper treats that warning as
  a failed `git add`. A fixture named `nul.md` cannot exist, because `NUL` is a reserved name
  (#288).
- **3: frontmatter in a CRLF checkout.** `scripts/check-version.ts` reads no `metadata.requires`
  from `skills/accreta-setup/SKILL.md` when Git checks it out with CRLF line endings. The page
  parser accepts CRLF, so only the release script is affected
  ([#286](https://github.com/francescofioredev/accreta/issues/286)).
- **21 others**, mostly `accreta doctor`'s skill checks. These have not been looked into yet
  (#288).

### Git from the current directory

On Windows, a spawn searches its working directory before `PATH`. The git adapter runs
`spawn("git", args, { cwd: root })`, so a `git.exe` committed at a source root would run in
place of the real one ([#244](https://github.com/francescofioredev/accreta/issues/244)).

The Windows cells check this. They copy `node.exe` to `git.exe` in an empty directory, and spawn
`git --version` with that directory as `cwd`. Under both Node and Bun the answer was a Node
version, not `git version`, so the copied file ran. The fix #244 proposes is to resolve git to an
absolute path from `PATH` once.
