# Storage, concurrency, and when the filesystem stops making sense

> One of six independent reviews, August 2026. Each reviewer worked from a single
> disciplinary lens with no sight of the others' work; an adversarial verifier then
> checked every citation and every `file:line` and rejected what did not survive.
> **Read `00-register.md` for what was confirmed** — this report is the raw finding,
> before verification.
>
> **Owns:** Q5 (the filesystem threshold), and the standing attack on ADR-0004
> **Agent:** `.claude/agents/accreta-storage-engineer.md`
>
> Evidence grades: **MEASURED** (ran it, with numbers and command) ·
> **CITED** (a source with the specific result relied on) ·
> **REASONED** (an argument from the code, the weakest grade).

## F-SE-01: A long-lived MCP server permanently hard-fails after any reindex, and the code has no reopen path
- Severity: high
- Evidence: MEASURED + CITED. MEASURED on darwin 26.5.2 / arm64 / bun 1.3.13, mirroring openIndex(path,{readonly:true}) then the build.ts staging-and-rename sequence:
    before swap:                    [{"body":"OLD"}]
    AFTER swap, same connection:    THREW disk I/O error
    AFTER swap, fresh statement:    THREW disk I/O error
    fresh connection sees:          [{"body":"NEW"}]
  A second run swapped three times against one held reader and re-queried after 200ms settle: "after swap 2/3/4: THREW disk I/O error", "after 200ms: THREW disk I/O error". The failure is PERMANENT and PER-CONNECTION, not transient.
  CITED - POSIX/IEEE Std 1003.1 rename(), https://pubs.opengroup.org/onlinepubs/9699919799/functions/rename.html: "If the link named by the new argument exists, it shall be removed and old renamed to new. In this case, a link named new shall remain visible to other threads throughout the renaming operation" and "If one or more processes have the file open when the last link is removed, the link shall be removed before rename() returns, but the removal of the file contents shall be postponed until all references to the file are closed." POSIX guarantees the PATH never names a partial file and the old inode's CONTENTS survive for the open descriptor. It guarantees nothing about a reader continuing to make sense of it.
  CITED - SQLite, "How To Corrupt An SQLite Database File" section 2.5, https://www.sqlite.org/howtocorrupt.html: "unlinking or renaming an open database file results in behavior that is undefined and probably undesirable." SQLite >=3.7.17 logs SQLITE_WARNING.
- Where: packages/mcp-server/src/context.ts:92 (opened once in createContext, never reopened); packages/core/src/index-db/build.ts:105-109
- Failure scenario: An agent has the MCP server attached over stdio. It calls update_verified_revision, which by design writes markdown and instructs the caller to run accreta reindex. From that moment every one of the seven read tools throws disk I/O error for the life of the process. The agent sees a tool that worked a minute ago now returning a SQLite error naming no page and suggesting no remedy. Recovery requires restarting the MCP server, which the tool never says. The build.ts comment says "A long-lived reader must therefore reopen after a rebuild" - correct, and NO CODE ANYWHERE DOES IT.
- CREDIT: the platform split in the build.ts comment (82-88) is real, and renaming OVER the target rather than unlink-then-rename (105-108) is right for exactly the reason stated. My measurement reproduces the macOS half precisely. This is a well-diagnosed problem that was documented instead of fixed.
- Falsifiable proposal: give ToolContext a db accessor that stats the index path (dev+ino, or mtime+size) before each tool call and reopens on change; or catch SQLITE_IOERR once per call and reopen before failing. Wrong if a reader that reopens on inode change still throws after a swap on either platform. Also wrong if on Linux the stale reader is measured to serve CORRECT rows indefinitely with no detectable inode change, in which case inode-stat is insufficient.
- Cost to verify: 2h. Needs a Linux runner for the other half of the split.
- Confidence: high for macOS (measured, repeated, permanent). MEDIUM for the Linux claim, which I did not measure.

## F-SE-02: The Linux half of the split is the worse failure, and the project has chosen the platform that fails loudly by accident, not by design
- Severity: high
- Evidence: REASONED. THIS FINDING REACHES ONLY REASONED AND SAYS SO. Derived from build.ts:82-88 (the comment asserting Linux keeps serving the unlinked inode) plus the POSIX text in F-SE-01, which does guarantee the old inode's contents survive an open descriptor. I measured macOS only.
- Where: design-level; packages/core/src/index-db/build.ts:82-88, packages/mcp-server/src/context.ts:92
- Failure scenario: On Linux - where MCP servers in containers and CI predominantly run - the reader keeps serving the pre-rebuild inode. An agent verifies a page, records a new last_verified_revision, reindexes, then asks get_page and is served the page AS IT WAS BEFORE ITS OWN WRITE. It re-verifies and re-verifies, converging on nothing, with every tool call returning success. detectDrift compares recorded revisions against a stale pages table and reports "up to date" for pages that are not. That is precisely the class the project names as characteristic: quietly wrong. macOS's disk I/O error is strictly BETTER - loud, immediate, unignorable. The project gets the good behaviour where it is developed and the bad behaviour where it is deployed.
- Falsifiable proposal: do not rely on either platform. Write a monotonically increasing build generation into meta (e.g. build_id, a UUID per rebuild) and have every MCP tool call compare its connection's meta.build_id against a cheap stat; on mismatch, reopen. Converts an undefined-behaviour dependency into an explicit check identical on both platforms. Wrong if a Linux measurement shows the stale reader ALSO errors, in which case severity drops to medium and reopen-on-error suffices.
- Cost to verify: 1h on a Linux runner; the F-SE-01 script needs no changes.
- Confidence: medium. Well-supported by POSIX and by the project's own CI observation, but I did not run it on Linux and will not claim a number I do not have.

## F-SE-03: Two concurrent rebuilds contend on a fixed staging filename; the loser's work is silently discarded and one session's disk I/O error is the only signal
- Severity: high
- Evidence: MEASURED. No lock file, advisory lock, lease, PID-stamped or mkdtemp staging path anywhere in packages/ - verified by grep for flock|lockfile|advisory|O_EXCL|process.pid, zero hits outside tests. Modelled buildIndex's exact ordering in two overlapping async builds, swept across timing skews:
    skew=0..16ms   B:OK  A:ERR disk I/O error  => index holds only B
    skew=20..28ms  A:ERR disk I/O error  B:OK  => index holds only B
  And a slow SESSION-A (40 pages) overlapped by a fast SESSION-B (5 pages) 30ms in:
    SESSION-A rm staging / SESSION-B rm staging / SESSION-B rename / SESSION-B OK / SESSION-A ERR disk I/O error
    FINAL: [{"body":"SESSION-B","c":5}]   integrity: ok
  In EVERY trial PRAGMA integrity_check returned ok. The surviving file is a VALID database - of one session's corpus only.
- Where: packages/core/src/index-db/build.ts:93 (fixed `${indexPath}.building`), :94 (removeIndexFiles unconditionally deletes a peer's in-flight staging file), :109 (renameSync)
- Failure scenario: Two agent sessions work the same knowledge base - realistic, since the tool's own loop is "write markdown, then reindex". Session A edits 40 pages and reindexes; Session B edits 5 different pages 30ms later. B's removeIndexFiles unlinks the staging file A is actively writing into; A dies with disk I/O error. The index left on disk passes integrity_check and contains ONLY B's five pages. A's 40 markdown files are still correct on disk - the source of truth survives, ADR-0004 earning its keep - but the index that MCP and lint and drift all read silently omits 40 pages. lint reports no findings about them because it iterates the pages table, not the filesystem. A does see an error, but it is disk I/O error with no mention of concurrency, and the natural response (re-run reindex) happens to fix it, which is why this would be misfiled as flakiness rather than a race.
- CREDIT: the blast radius is genuinely bounded by ADR-0004. Because markdown is the source of truth and the index disposable, no DATA is lost - only a derived artifact goes stale, and one more reindex restores it. A design making the index authoritative would have lost 40 pages of provenance here. This is the ADR paying off under stress it was not explicitly designed for.
- Falsifiable proposal: (a) unique staging path per process - `${indexPath}.building.${process.pid}.${randomUUID()}` - so removeIndexFiles can never touch a peer's file and both rebuilds succeed, last-rename-wins with a complete index either way. (b) an O_EXCL lock file at `${indexPath}.lock` containing the pid, failing with "another reindex is running (pid N)" rather than disk I/O error. Disproof of (a): if with unique staging paths the sweep still produces an index missing pages from the winning session, the race is not in the staging file. Disproof of (b): if a stale lock from a killed process makes reindex permanently unusable, the lock needs a liveness check or must be dropped in favour of (a).
- Cost to verify: 3h including a regression test.
- Confidence: high. Reproduced across 14 timing skews and three harness shapes.

## F-SE-04: There is no state where the index exists, looks valid, and is wrong from a crash - the seal-and-rename ordering is correct
- Severity: low
- Evidence: MEASURED. Walked each crash window. Crash between BEGIN and COMMIT: transaction abandoned, staging retains .building/-wal/-shm; the LIVE index is untouched because the rename has not happened. Measured: "staging after abandoned txn: [ '', '-wal', '-shm' ]" with the live index still reading previous contents. Crash between rename (:109) and sidecar cleanup (:113-115), simulated by renaming then recreating orphan sidecars: "index reads: [{'path':'p1','body':'NEW'}]", "integrity: ok". The renamed database is sealed to journal_mode=DELETE BEFORE the rename (sealForReading at :100, rename at :109), so it needs no sidecars. The orphans are inert litter cleared by the next removeIndexFiles.
  CITED - SQLite howtocorrupt.html section 2.5 warns that two connections sharing a name share a rollback journal or WAL and "a rollback or recovery for one of the databases might use content from the other database, resulting in corruption." Sealing to DELETE before the rename is exactly what defuses this.
- Where: packages/core/src/index-db/db.ts:43-46 (sealForReading); packages/core/src/index-db/build.ts:100 then :109 - THE ORDERING IS THE LOAD-BEARING PART
- Failure scenario: none found in the single-writer case. I went looking for the "exists, looks valid, is wrong" state and did not find one reachable by process death alone. It IS reachable by the F-SE-03 race, but that is a different mechanism.
- CREDIT: seal-then-rename, with the rename last and over the target rather than after an unlink, is the correct ordering and a reviewer would be tempted to flag the WAL handling as sloppy. It is not. The sealForReading comment records two real incidents (108MB WAL against a 12MB database; a served index needing a -shm it is not allowed to create) and the fix addresses both plus a third - WAL-sharing corruption - that the comment does not claim credit for. Likewise db.ts:22-24 on read-only/-shm.
- Falsifiable proposal: none needed for correctness. One durability gap worth NAMING AND NOT FIXING HASTILY: nothing calls fsync on the containing directory after renameSync, so on power loss immediately after a rebuild the directory entry may not be durable and the index can revert to the previous generation. Harmless here - the index is disposable - so leave it alone and record why in the comment. Wrong if a power-loss test produces an index present but TRUNCATED or unreadable rather than cleanly old-or-new.
- Cost to verify: 4h, needs a VM that can be hard-reset mid-rebuild. I did NOT do this; process-kill is not power-loss.
- Confidence: high for process-death windows which I measured. LOW for the power-loss claim, which I did not measure and flag as such.

## F-SE-05: revision() on 10^5 files costs 315ms and is not the scaling problem - ADR-0002's stat-walk choice is vindicated
- Severity: low
- Evidence: MEASURED. Verbatim port of FsSource.scan/walk/revision, on freshly generated trees of 400-byte files at 100 files per directory, three reps each, darwin arm64 / bun 1.3.13 / Apple M3 / 16GB:
    files=1000    revision()=3.8, 2.7, 2.8 ms
    files=10000   revision()=32.0, 30.5, 30.4 ms
    files=100000  revision()=325.4, 315.4, 308.9 ms
  Clean linear scaling, ~3.1us per file, no knee. Snapshot map footprint at 10^5 entries roughly 7.4MB by conservative estimate.
- Where: packages/adapters/fs/src/index.ts:66-75, :114-145; ADR-0002 rejection of content hashing
- Failure scenario: none at target scales. ADR-0002's defence - "it turns revision() from a stat walk into a full read of the corpus, and revision() is called on every drift check" - is quantitatively right. Reading 10^5 files of ~1.1KB measured roughly 4.2 seconds, so content hashing would be a 13x cost increase on the operation that runs on every drift check.
- CREDIT: this is the ADR-0002 decision a reviewer would most want to attack ("mtime is unreliable, hash the contents") and the numbers say the authors were correct on cost. The blind spot they document is real but it is not a PERFORMANCE argument, and they did not confuse the two.
- Falsifiable proposal: none - keep the stat walk. Optionally bound the snapshots map (packages/adapters/fs/src/index.ts:57), currently unbounded for the process lifetime; at ~7.4MB per snapshot on a 10^5-file corpus a long-running server accumulates that per distinct revision observed. Wrong if a long-running server's RSS is measured flat across hundreds of drift checks.
- Cost to verify: 1h for the bounded map; the memory claim needs a soak test that does not exist.
- Confidence: high for the timing. Medium for the snapshot-memory figure, a structural estimate not a heap measurement.

## F-SE-06: mtime-based revision identity produces false-positive drift on git checkout and on every rsync, and the ADR documents only the false-negative
- Severity: medium
- Evidence: MEASURED, darwin 26.5.2 / APFS. revision() over the same tree after each operation:
    baseline                          rev=91988a87835f
    git checkout HEAD -- docs (noop)  rev=91988a87835f   unchanged
    branch switch away and back       rev=91988a87835f   unchanged
    cp -a  (preserves mtime)          rev=91988a87835f   unchanged
    tar create + extract (restore)    rev=91988a87835f   unchanged
    cp -R  (does not preserve mtime)  rev=a9f7d3eb904c   CHANGED
    rsync -a (preserves mtime)        rev=92c722c0e7ac   CHANGED
    rsync -r (no -t)                  rev=e7f87faf02c6   CHANGED
  The rsync -a result is a PRECISION ARTEFACT: APFS mtimeMs carries sub-millisecond precision, rsync stores whole seconds -
    source:         mtimeMs = 1786346632206.3245  (integer? false)
    after rsync -a: mtimeMs = 1786346632000       (integer? true)
  And a git checkout restoring OLDER content stamps a fresh mtime, so content going backwards reads as a change. Separately the documented FALSE-NEGATIVE is HARDER to hit than the ADR implies: restoring an mtime with utimes after a content change does not reproduce the revision, because the restored value loses sub-millisecond precision. The blind spot is real but narrow on APFS.
- Where: packages/adapters/fs/src/index.ts:66-75; ADR-0002 Consequences first bullet
- Failure scenario: a team keeps an fs source on a documents directory synced to CI with rsync -a, or rebuilds a container. Every sync changes revision() for every file though not one byte changed. On the next drift, every page recording the old revision is compared via changedSince - which for a revision from a previous process throws UnknownRevisionError and lands in unresolvable. The user sees the ENTIRE knowledge base reported unresolvable after an operation that changed nothing. Not silent wrongness - drift.ts:24 is explicit that unresolvable is not "current" - but it is the false-positive flood the GIT adapter's paths comment correctly identifies as the thing "people learn to ignore, which costs more than having no report at all." The fs adapter reintroduces exactly what the git adapter was careful to prevent.
- CREDIT: changedSince throwing UnknownRevisionError rather than returning [] (packages/adapters/fs/src/index.ts:80-84) is the single most important line in the adapter, and "'I cannot tell' is not 'nothing changed'" is exactly right. The atlas findings confirm the cost of the opposite choice: a misconfigured root made drift a no-op THAT REPORTED SUCCESS, judged "the worst available failure mode."
- Falsifiable proposal: quantize mtimeMs to whole seconds in the hash (Math.floor(entry.mtimeMs/1000)), making revision() invariant under rsync -a, cp -a and tar restore, at the cost of widening the false-negative window to one second. WRONG IF quantizing misses a realistic edit - two saves of the same file within one second, which an agent writing pages in a loop absolutely does. That test is cheap and should be run BEFORE adopting this: I measured two successive writeFileSync calls landing 0.04ms apart (m1 1786346632255.107, m2 1786346632255.1506), so within-second double-writes are not hypothetical and THIS PROPOSAL MAY WELL BE REFUTED.
- Cost to verify: 2h. Needs a product decision on which error is worse for the fs adapter's intended users.
- Confidence: high on measurements. Medium on the proposal, deliberately written with its own likely refutation attached.

## F-SE-07: Git is not the binding constraint at 10^5 pages - it is comfortably the fastest layer measured
- Severity: low
- Evidence: MEASURED. A real git repository with 100,000 markdown files of ~400 bytes, 100 per directory, 1000 directories, darwin 26.5.2 / APFS / M3:
    git add -A (initial, 100k files)   real 5.84s
    git commit                          real 0.78s
    git status --porcelain (clean)      real 0.11s
    .git size 12MB    working tree 391MB
  Then 50 pages edited and committed, and the operations the drift path uses:
    git add -A (50 changed of 100k)                    real 0.18s
    git diff --name-only <r1> <r2>   x3                real 0.00, 0.00, 0.00
    git rev-list -1 HEAD -- <one path>  x3             real 0.00, 0.00, 0.00
    git diff --name-only <r1> HEAD across 60 commits   real 0.00
  Both commands GitSource issues are BELOW TIMER RESOLUTION at 10^5 files.
  CITED for the far end: Microsoft Azure DevOps engineering, "The largest Git repo on the planet", https://devblogs.microsoft.com/bharry/the-largest-git-repo-on-the-planet/, 2017 - the Windows repository at 3.5 million files / 270GB is where stock git breaks down, with git checkout at 2-3 hours and git status at ~10 minutes, requiring GVFS. Graded as vendor engineering reporting on their own product, which is what it is. Setting differs (Windows source tree with large binaries vs small markdown) so transfer is DIRECTIONAL ONLY: git's wall is roughly 1.5 orders of magnitude beyond 10^5 small files.
- Where: packages/adapters/git/src/index.ts:85-110; ADR-0004
- Failure scenario: none at 10^5. The interesting negative result is that the merge-conflict question has no PERFORMANCE answer - it has a human one (F-SE-09).
- CREDIT: ADR-0004's core bet - plain markdown in git - is correct at every scale I could measure. The 391MB working tree compressing to a 12MB .git is git's delta and zlib compression doing exactly what makes it a good fit for many small text files.
- Falsifiable proposal: none. Record these numbers in ADR-0004 to replace the speculative "at a hundred thousand this decision would need revisiting" - git specifically does NOT need revisiting at 10^5; the rebuild does (F-SE-08). Wrong if git diff --name-only is measured above 1 second on a repository with deep history (tens of thousands of commits, which my 60-commit test does not model).
- Cost to verify: 2h to extend to deep history.
- Confidence: high for file-count scaling. Medium overall, because deep history is genuinely unmeasured.

## F-SE-08: Q5 answered - the binding resource is rebuild latency inside the agent's verification loop, and the threshold is ~15,000-20,000 pages
- Severity: high
- Evidence: MEASURED. Full rebuild curve, darwin arm64 / bun 1.3.13 / Apple M3 / 16GB:
    pages   links    build     index    per-page
    100     -        48ms      0.5MB    0.480ms
    300     1,090    82ms      1.4MB    0.273ms
    1,000   -        151ms     4.5MB    0.151ms
    3,000   11,687   316ms     13.4MB   0.105ms
    5,000   19,597   684ms     22.3MB   0.137ms
    10,000  39,407   942-1112ms 44.7MB  0.094ms
    15,000  59,269   1,348ms   67.6MB   0.090ms
    20,000  79,159   2,628ms   90.5MB   0.131ms
    30,000  118,928  5,830ms   134.8MB  0.194ms
    40,000  158,724  9,181ms   179.5MB  0.230ms
    50,000  198,564  11,246ms  223.8MB  0.225ms
    100,000 -        24,972ms  449.1MB  0.250ms
  Per-page cost falls to a minimum of 0.090ms AT 15,000 PAGES then rises monotonically. Between 15,000 and 20,000 the build grows 1.95x for 1.33x the pages - THE KNEE.
  I then LOCALISED the cause. Stage isolation (walk, readFileSync, statSync, parsePage, link extraction, JSON.stringify):
    n=10000 walk=7   read=204   stat=21  parse=315  links=45  json=9   TOTAL=601ms
    n=30000 walk=18  read=2314  stat=75  parse=833  links=132 json=32  TOTAL=3404ms
    n=50000 walk=36  read=4993  stat=105 parse=1535 links=273 json=60  TOTAL=7001ms
  readFileSync goes 204ms -> 4,993ms: 24x FOR 5x THE FILES, dominating everything.
  It is NOT SQLite - replaying the identical insert workload directly against the schema is linear, and raising cache_size to 200MB changes nothing:
    n=10000 default=347ms cache200MB=347ms  n=50000 default=1853ms cache200MB=1636ms
  It is NOT retention or GC - streaming reads without keeping strings is just as slow (n=50000 retain=4991ms stream=4797ms, RSS only 183MB).
  It is NOT directory-entry limits - flat vs 100-per-directory within noise (n=50000 flat=1999ms 100/dir=2174ms).
  It is per-file syscall cost against APFS metadata, saturating as a STEP:
    n=5000 13.0us   n=10000 22.1us   n=20000 43.3us   n=30000 40.1us   n=50000 41.9us   n=70000 42.2us
  ~13us per file while the tree's metadata fits in cache, ~42us once it does not, transition at ~20,000 files. A 3.2x STEP IN A CONSTANT FACTOR, not unbounded growth - beyond ~20,000 the rebuild is linear again at the higher rate.
  Query paths are not binding: at 50,000 search=71ms getPage=0.01ms findRelated=18ms findCanonical=65ms lint=134ms. At 100,000 lint=317ms search=146ms.
- Where: packages/core/src/index-db/build.ts:169-171 (per-file readFileSync + statSync inside the walk loop); ADR-0004; .gitignore:14
- THE ANSWER: the filesystem stops making sense at 15,000-20,000 PAGES, and what binds is REBUILD LATENCY INSIDE THE AGENT'S VERIFICATION LOOP - not memory, not stat cost during drift, not git, not directory-entry limits. update_verified_revision instructs the caller to reindex, so a full rebuild is paid on every verification pass. Bands: ~1,000 pages sub-150ms (instantaneous); ~10,000-15,000 ~1s (tolerable); ~20,000 past 2.5s (the knee); ~50,000 at 11s (more wall-clock reindexing than reasoning); 100,000 at 25s, where a session verifying 20 pages spends 8.3 MINUTES in reindex alone. Ranked by when they would bind if rebuild were free: index size 449MB at 10^5 (fine), fs revision() 315ms (fine), git diff below timer resolution (fine), lint 317ms (fine). REBUILD LATENCY BINDS FIRST BY MORE THAN AN ORDER OF MAGNITUDE.
- On the ADR-0004 / .gitignore discrepancy: both are wrong in the same direction. ADR-0004 says 43ms for 300 pages; I measure 82ms for 300 pages AND 1,090 LINKS. .gitignore says ~150ms; that matches 1,000 pages (151ms), not 300.
- Failure scenario: a team reaches 30,000 pages. An agent verifies 30 pages against moved sources. Each update_verified_revision is followed by reindex at 5.8 seconds - ~3 MINUTES rebuilding an index whose content changed by one frontmatter line each time. Nothing is WRONG - no provenance violated, no drift missed - which is why this will be experienced as "accreta is slow" rather than as a design threshold being crossed. ADR-0004 anticipated this but placed the threshold an order of magnitude too high.
- CREDIT: ADR-0004's REASONING for rejecting incremental indexing is sound and my measurements do not overturn it - sub-second rebuild up to 15,000 pages is a genuinely good place to be. The ADR is right about the trade and wrong only about where the trade expires.
- Falsifiable proposal: (a) correct the numbers in ADR-0004 and .gitignore and replace "at a hundred thousand" with the measured knee at 15,000-20,000. Zero risk. (b) PARALLELISE THE READ STAGE - readFileSync is ~71% of build time at 50,000 and is syscall-bound, not CPU-bound, so it should parallelise while leaving the single-transaction insert and therefore ADR-0004's all-or-nothing semantics COMPLETELY INTACT. The rare optimisation that does not trade away the property the ADR protects. Wrong if a concurrent-read implementation measures less than 1.5x at 30,000. (c) only if (b) is insufficient, revisit incrementality - and note pages.mtime and meta.max_mtime are already written by build.ts and read by NOTHING, so an mtime-gated rebuild is half-implemented in the schema. Disproof of (c): if an mtime-gated incremental rebuild produces an index differing from wholesale on any corpus in the test suite, ADR-0004's staleness argument is confirmed and (c) must be abandoned - which is the outcome I would expect and why (c) is third.
- Cost to verify: (a) 30 min. (b) 6h. (c) 3 days, and should not start until (b) is measured.
- Confidence: high. Curve measured at eleven sizes, cause isolated by elimination of three plausible alternatives, saturation confirmed to 70,000 files.

## F-SE-09: A merge conflict inside page frontmatter has no resolution procedure, and the field most likely to conflict is the one drift depends on
- Severity: medium
- Evidence: REASONED. THIS FINDING REACHES ONLY REASONED AND SAYS SO - I did not construct a live three-way merge. Derived from build.ts:189 (last_verified_revision read straight from frontmatter into the index); ADR-0004 "Frontmatter is edited a line at a time, never parsed and reserialized"; the update_verified_revision contract; and the atlas finding that a bare all-digit revision is silently coerced to null by YAML.
- Where: design-level; packages/core/src/index-db/build.ts:183-195; ADR-0004
- Failure scenario: two branches each verify the same page against different revisions. Both edit exactly one line - last_verified_revision: - so git conflicts on that line and a human resolves it. The resolver is typically neither author, and the two candidates are opaque hashes with nothing indicating which source revision is LATER. There is no tooling to help: no accreta command compares two revisions of a source. The natural resolution - take HEAD's, or the longer-looking one - has a 50% chance of recording a page as verified against an OLDER source revision than it actually was. That page reads as more current than it is, and detectDrift skips it whenever the recorded revision equals the current one. A page silently claiming verification it does not have - the constitution's second property failing quietly. A conflict resolved by accidentally leaving a marker produces a value the hand-rolled parser reads as SOMETHING, and the atlas finding shows this family already lands as null rather than an error - at which point the page becomes "unverifiable", which is at least honest.
- CREDIT: the two-step confirm-token protocol ("the token is derived from the page, the new revision and the current value, so it cannot be reused for a different edit") is a genuinely good design preventing an agent from clobbering a value it did not read. It solves the SINGLE-WRITER version of exactly this problem. The gap is that it has no analogue for the git-merge case, where the clobber happens outside the tool entirely.
- Falsifiable proposal: a .gitattributes entry shipped by accreta init marking KB markdown with a union or custom merge driver, plus an accreta lint finding for a frontmatter value that is syntactically well-formed but not a revision any configured source can resolve - catching a botched merge at the next lint rather than the next drift check. The lint check is the higher-value half. WRONG IF adding the check produces findings on a healthy knowledge base - for instance because a legitimately pinned frozen-corpus revision is unresolvable BY DESIGN, which the atlas frozen-corpus mechanism suggests is a real pattern, in which case narrow to conflict-marker detection only.
- Cost to verify: 4h. Needs a decision on whether unresolvable-by-design pinning is supported; the atlas fixtures/unresolvable canary suggests it is, WHICH MAY REFUTE THE PROPOSAL AS STATED.
- Confidence: medium. Mechanism follows clearly from the code, but I did not run a merge, and severity depends on a human-behaviour claim I cannot measure.

## Experiment cards
1. Does the stale MCP reader on Linux serve silently-wrong answers? Run the F-SE-01 script unchanged on ext4 AND overlayfs, 20 reps. Metric: fraction of trials where the held reader returns OLD with no exception - chosen over latency because the only thing that matters is whether a wrong answer is RETURNED rather than RAISED. Falsification: if the held reader raises in more than 1 of 20 on either filesystem, the Linux-is-silent claim is refuted, F-SE-02 drops to medium, and reopen-on-error suffices. Cost 1h. Not measured: whether the stale reader eventually errors after page-cache eviction under memory pressure, which would make behaviour timing-dependent and worse than either branch.
2. Is readFileSync parallelisable enough to move the knee? Fork scale-bench into a variant whose walk collects paths then reads with a concurrency limiter at N in {1,4,8,16,32,64}, feeding the same single transaction in path-sorted order so the index is byte-identical. Verify by comparing sha256 of the sealed index against the serial build. Metric: wall-clock at each (size,N) AND the index hash - a speedup that changes the index is not a speedup. Falsification: if median at N=16 is within 1.5x of N=1 at 30,000 pages, the read is not latency-bound, proposal (b) is refuted, and incrementality becomes the only lever - at which point ADR-0004 must be reopened on its merits. Cost 6h. Not measured: ext4/overlayfs/network filesystems, where the optimal N almost certainly differs; peak RSS in a small container.

## What I could not establish
- THE LINUX HALF OF THE RENAME BEHAVIOUR. The single most important gap. F-SE-01 measures macOS conclusively; F-SE-02 - which argues the Linux behaviour is the WORSE one and the one that matters for deployment - rests entirely on the build.ts comment plus POSIX text, and is graded REASONED for that reason. The whole severity ordering between platforms depends on a measurement I could not take. One hour on a Linux runner.
- Whether the concurrent-writer race can produce a MIXED index rather than a truncated one. I found truncation reliably and tried four interleavings to produce a mixed index. Every attempt was defeated by the DELETE FROM pages at build.ts:164. I could not construct the mixed state and AM NOT CONFIDENT IT IS UNREACHABLE - only that I did not reach it. A writer interrupted AFTER the DELETE but before its inserts complete, with the peer's rename landing in between, is the shape I would keep probing. If it exists it is more severe, because a mixed index passes integrity_check and looks complete.
- Power-loss durability. F-SE-04 tests process death, which is not the same thing. The claim that the missing directory fsync is harmless is reasoning from the index's disposability, not a measurement.
- Deep git history. F-SE-07 measures file count thoroughly (100,000) and history depth barely (60 commits). A KB maintained for a year could have tens of thousands of commits, and git diff --name-only between distant revisions is what changedSince performs on every drift check.
- Whether the frontmatter merge-conflict scenario matches what git actually produces. I did not run a three-way merge on adjacent frontmatter lines. If git merges them CLEANLY the finding changes shape entirely - it becomes a silent wrong-value bug with no conflict marker to warn anyone, which would be MORE severe rather than less.
- The snapshots map memory figure. 7.4MB per snapshot is a structural estimate from entry sizes, not a heap measurement.
