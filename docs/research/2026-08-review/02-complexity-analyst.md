# Scale, complexity, and whether a graph database earns its place

> One of six independent reviews, August 2026. Each reviewer worked from a single
> disciplinary lens with no sight of the others' work; an adversarial verifier then
> checked every citation and every `file:line` and rejected what did not survive.
> **Read `00-register.md` for what was confirmed** — this report is the raw finding,
> before verification.
>
> **Owns:** Q2 (behaviour at scale), Q4 (graph databases)
> **Agent:** `.claude/agents/accreta-complexity-analyst.md`
>
> Evidence grades: **MEASURED** (ran it, with numbers and command) ·
> **CITED** (a source with the specific result relied on) ·
> **REASONED** (an argument from the code, the weakest grade).

## F-CA-01: The rebuild is linear to 10^4 and turns superlinear past it; the knee is between 10^4 and 10^5, not at 300 pages
- Severity: medium
- Evidence: MEASURED. Reproduced on darwin arm64, bun 1.3.13: 100 pages/335 links build 44ms index 0.5MB; 1,000/3,800 build 128ms 4.5MB; 10,000/39,407 build 1,081ms 44.7MB. These match the handed numbers (48/151/1,112ms) within noise, so I CONFIRM rather than dispute. Log-log slope of build time vs page count: 0.46 (100->1k), 0.93 (1k->10k), 1.36 (10k->100k, using the 24,972ms figure measured once, which I did not re-run). Per-page cost bottoms at 0.108 ms/page at 10^4 and rises to 0.250 ms/page at 10^5 - a 2.3x per-unit regression. Index size is dead linear throughout (slope 1.00, 4.6 KB/page from 10^3 up).
- Where: packages/core/src/index-db/build.ts runBuild; docs/adr/0004-markdown-source-of-truth.md ("Rebuild cost grows linearly with corpus size")
- Failure scenario: ADR-0004 asserts linear growth and says "at a hundred thousand this decision would need revisiting". Growth stops being linear BEFORE the pain is felt. At 10^4 a reindex is 1.1s; update_verified_revision instructs the caller to reindex, so an agent verifying 50 pages pays ~54s of pure rebuild, 500 pages ~9 minutes, for edits touching one page each. The user sees an agent that appears to hang between edits.
- Falsifiable proposal: Keep wholesale rebuild (see F-CA-06) but add a documented ceiling to ADR-0004: the measured knee and per-reindex cost at each order of magnitude, replacing "grows linearly" with the measured slope table. Separately, batch reindexing: let update_verified_revision mark the index dirty and reindex once per pass. Wrong if a rebuild once per pass shows no aggregate saving - i.e. if agents verify one page per pass, making batch size 1.
- Cost to verify: 2h. Needs an instrumented count of update_verified_revision calls per session against accreta-atlas, which is not recorded.
- Confidence: high for 100-10,000 which I ran. MEDIUM for the 10^5 slope - single un-replicated run on a machine I did not control, and one sample cannot separate a real complexity change from memory pressure at 449MB.

## F-CA-02: The "~150ms" in .gitignore was written before any code existed and never measured anything
- Severity: low
- Evidence: MEASURED (provenance, via git). `git show 53ef1e3:.gitignore` carries "rebuilt from the knowledge base in ~150ms" at commit 53ef1e3, whose message reads "This first commit is the landing page and the rules of engagement, BEFORE ANY CODE". `git ls-tree -r --name-only 53ef1e3` lists ten files: LICENSE, README, CONTRIBUTING, .gitignore, GitHub templates. No packages/, no indexer, no corpus. The 43ms in ADR-0004 arrives later, at 553a13e.
- Where: .gitignore:11-13; docs/adr/0004-markdown-source-of-truth.md
- Failure scenario: The instruction to find which is "wrong" has a cleaner answer than a disagreement between two measurements: they do not measure the same thing because ONE IS NOT A MEASUREMENT AT ALL. It now reads as a competing empirical claim, and a reader reconciling it against 43ms concludes the project measured the same operation twice and got different answers - eroding trust in numbers that are, in the ADR's case, real. Note the direction: my interpolation puts 300 pages at roughly 60-70ms, so the invented 150ms is the PESSIMISTIC one and 43ms is plausible.
- Falsifiable proposal: Delete the "~150ms" and give the reason for gitignoring the index without a number (the binary-blob argument stands alone). Wrong if the 150ms traces to a real measurement in the private system accreta was extracted from - in which case label it as such, because a measurement of a different system is evidence about a different system.
- Cost to verify: 15 minutes.
- Confidence: high.

## F-CA-03: Every query path except findCanonical and lint is index-served; those two are full scans, and neither has a LIMIT
- Severity: medium
- Evidence: MEASURED + REASONED. At 10,000 pages: search 13ms, getPage 0.01ms, findRelated 3ms, findCanonical 13ms, lint 22ms. Log-log slopes 1,000->10,000: findCanonical 1.45, lint 1.35 - both superlinear across that decade, against findRelated 1.03 and index size 1.00. Code: findCanonical issues WHERE LOWER(frontmatter_json) LIKE '%needle%' (packages/core/src/query/page.ts alias branch) - leading wildcard on a non-indexed expression, no index usable, plus JSON.parse per surviving row. lint (packages/core/src/query/lint.ts) loads all broken_links, a LEFT JOIN over links, and SELECT ... FROM pages ORDER BY path with no bound. getPage is a PK lookup, flat at 0.01ms across three orders of magnitude.
- Where: packages/core/src/query/page.ts (findCanonical alias branch), packages/core/src/query/lint.ts, packages/core/src/query/search.ts DEFAULT_LIMIT (the only bounded path)
- Failure scenario: findCanonical is the resolver an agent calls to answer "which page authoritatively defines X" - the entry point to provenance. At 10^5 it costs 136ms per call and returns an unbounded list. An agent resolving twenty concepts pays 2.7s and may receive an arbitrary-size result into its context. lint at 317ms returns EVERY finding: after a directory rename that is one dangling-link finding per link, tens of thousands of rows, no pagination.
- Falsifiable proposal: Give findCanonical and lint the same bounded contract search has (limit + total count, so truncation is visible rather than silent). For findCanonical, the alias branch can be index-served by writing aliases to their own indexed table at build time - the data is already extracted, aliasesOf in build.ts computes it for FTS. Wrong if an alias table fails to beat the LIKE scan at 10^4 - measure both first. Note the LIKE scan is at least CORRECT: the JSON.parse confirmation means a page merely containing the word is not a false positive.
- Cost to verify: 3h.
- Confidence: high.

## F-CA-04: No traversal a knowledge base plausibly needs requires a graph database - SQLite serves all of them, and I measured every one
- Severity: low (a "do not do the thing" finding)
- Evidence: MEASURED. Wrote recursive CTEs for every traversal in the remit and ran them against a 10,000-page / 40,406-link preferential-attachment corpus in a temp directory outside both repos. Measured in-degree: top five 1727, 1620, 1123, 1037, 1037 - genuine hubs, so not flattered by uniform degree.
  | Traversal | Serves it? | Measured at 10^4 |
  | one-hop "what links here" | already shipped, index-served | findRelated 3ms |
  | authority ranking over citations | one GROUP BY dst_path, no recursion | 1.8ms for top-20 |
  | two-hop / transitive closure (outbound, from a leaf) | recursive CTE | 0.02ms (d<=2), 0.32ms (d<=8) |
  | transitive closure inbound from the HUB (adversarial) | recursive CTE | 26.7ms (d<=2), 362ms (d<=8) naive form; see F-CA-05 |
  | shortest path between two concepts | recursive CTE, bounded depth | 1.4ms, correctly found depth=2 |
  | cycle detection in supersedes chains | recursive CTE over kind='supersedes' | 141ms over 999 chain edges |
  | connected components | recursive CTE | 54ms in the correct formulation |
- Where: design-level; packages/core/src/index-db/schema.sql (links with idx_links_dst AND idx_links_src - indexes in BOTH directions, which is what makes this work)
- Failure scenario: The failure this prevents is adopting a second store. accreta ships with bun:sqlite as its only storage dependency and runs offline. Neo4j is server-based and breaks that outright. An embedded graph store (KuzuDB) does not break offline but breaks something ADR-0004 exists to protect: a SECOND DERIVED ARTIFACT to keep consistent with the markdown. The ADR's central argument is that a store which can disagree with the files while nothing notices is the worst trade available. A graph DB reintroduces precisely the staleness class ADR-0004 rejected incremental indexing to avoid.
- Falsifiable proposal: Do not adopt a graph database. Record this as an ADR with the measured table, so the question is answered with numbers rather than re-litigated on instinct. Wrong if someone demonstrates a traversal accreta actually needs whose SQLite implementation exceeds ~1s at 10^4 in its best formulation - variable-length path pattern matching with predicates on intermediate nodes is the plausible candidate, and no accreta feature requests it today.
- Cost to verify: already verified; 4h to commit the harness as bench/traversal-bench.ts.
- Confidence: high. Every row is a number I produced, and the adversarial cases (hub, inbound) are included rather than avoided.

## F-CA-05: A recursive CTE carrying a depth column silently defeats SQLite's cycle protection - 8,078ms became 54ms when I removed it
- Severity: medium
- Evidence: MEASURED + CITED. My first connected-components CTE carried a depth column: 8,078.5ms, reporting a component of "975,800" nodes in a 10,000-node graph - a nonsense number. Removing the depth column: 54.5ms, size=10000 (correct). A 148x speedup AND a correctness fix from one change. Inbound hub closure likewise: 362ms (depth-bounded d<=8, over-counting at 69,987) versus 33.0ms for the full closure with no depth column (9,999, correct). An in-process BFS reading the edge table once was 15.1ms, so the CTE is within 3.6x of hand-written traversal.
  CITED: SQLite recursive CTE docs, https://www.sqlite.org/lang_with.html - "If a UNION operator connects the initial-select with the recursive-select, then only add rows to the queue if no identical row has been previously added to the queue." The row is the WHOLE TUPLE. Adding depth makes (nodeA,3) distinct from (nodeA,5), so a node re-enters the queue once per distinct depth at which it is reachable; on a hub graph that is combinatorial. The same page shows the correct form and states UNION prevents infinite loops on cyclic graphs.
- Where: design-level - NO SUCH CTE EXISTS IN THE REPOSITORY TODAY. This is a trap laid for whoever writes the first one.
- Failure scenario: A future contributor writes a depth-tracking CTE (the natural formulation, since bounding depth is the obvious safety instinct), measures 8 seconds and a garbage node count at 10^4, concludes "SQLite cannot do graph traversal", and proposes KuzuDB or Neo4j. The dependency would then be justified by a benchmark measuring a DEFECT IN THE QUERY, not a limit of the engine. This is exactly the failure mode the remit warned about, and the measurement done properly points the other way.
- Falsifiable proposal: If any traversal ships, write it with UNION over the node column alone; if depth must be reported, compute it outside the recursion or accept UNION ALL with an explicit visited guard. Any traversal benchmark committed to bench/ must assert result SIZE alongside timing - the 975,800 figure was visible as wrong before the timing was. Wrong if a depth-carrying CTE can be shown to match the depth-free form on a hub-shaped graph; SQLite's queue semantics say it cannot, but that is testable in minutes.
- Cost to verify: 1h, largely done.
- Confidence: high. Mechanism documented by SQLite, effect 148x, and the incorrect result count independently confirms the diagnosis.

## F-CA-06: ADR-0004's rejection of incremental indexing is still right, and the measurement that would have overturned it does not
- Severity: low
- Evidence: MEASURED + REASONED. The ADR was decided on 43ms at 300 pages; the honest challenge is that a decision at 300 pages does not bind 10^5, and at 10^5 the rebuild is 24,972ms. But incremental indexing does not follow. Index size is exactly linear (4.6 KB/page from 10^3 to 10^5), so nothing about STORAGE degrades; what degrades is walk-and-reparse, and that is what an incremental scheme would have to track a dependency graph to avoid. Crucially, links and broken_links are GLOBAL: renaming one page changes the resolution status of every wikilink pointing at it, so an incremental update touching one file must still re-resolve links repo-wide or leave dangling-link findings wrong. lint's dangling-link LEFT JOIN is the check that would silently start lying.
- Where: docs/adr/0004-markdown-source-of-truth.md; packages/core/src/index-db/build.ts
- Failure scenario: Adopting incrementalism on the strength of the 25-second number alone. A per-file update that skips global link re-resolution produces an index where lint reports zero dangling links after a directory rename - the corpus looks healthy and its graph is broken. That is the "quietly wrong" failure the project names as characteristic.
- Falsifiable proposal: Keep the decision, and amend the ADR to say WHY it survives at scale (global link resolution, not rebuild speed) rather than resting on 43ms, now the weakest sentence in a correct document. Wrong if someone builds an incremental indexer maintaining global link resolution correctly and beats wholesale by >5x at 10^4 while passing the full lint suite.
- Cost to verify: 1 day to prototype; the lint suite already exists as the correctness oracle.
- Confidence: high on the mechanism; medium on the 5x threshold, a judgement call.
- CREDIT: the staging-file-plus-rename(2) swap is correct in a way a reviewer would be tempted to criticise as over-engineered, and its comment about /tmp being a different filesystem (EXDEV) and about macOS SQLITE_IOERR vs Linux's surviving inode encodes two real incidents; sealForReading checkpointing the WAL is likewise load-bearing, with a 108MB-WAL-against-12MB incident behind it. None of that should be tidied.

## F-CA-07: No degree distribution exists for any real accreta corpus - n=10 pages, max degree 4
- Severity: low
- Evidence: MEASURED (corpus census) + CITED. examples/climate/knowledge/ holds 10 PAGES. Inline wikilink counts per page: 7,5,3,3,2,2,2,1,1,1. The most-linked-to page (contradictions/permafrost-feedback-strength) has IN-DEGREE 3. accreta-atlas/kb/knowledge/ is empty by design. Total real-world evidence for the graph's shape: ten pages, roughly two dozen edges.
  CITED: Barabasi & Albert, "Emergence of scaling in random networks", Science 286(5439):509-512, 1999 - preferential attachment yields degree exponent gamma=3; bench/scale-bench.ts implements exactly this generator and its comment is candid that this is a modelled shape, not an observed one.
  CITED: Clauset, Shalizi & Newman, "Power-law distributions in empirical data", SIAM Review 51(4):661-703, 2009, https://arxiv.org/abs/0706.1062 - of twenty-four real-world data sets previously conjectured power-law, the hypothesis is supported for some and rejected in favour of alternatives for others. Transferable result is METHODOLOGICAL: a heavy tail observed by eye is not a fitted power law, and the fit must be tested against alternatives such as log-normal.
- Where: examples/climate/knowledge/ (10 pages), accreta-atlas/kb/knowledge/ (empty), bench/scale-bench.ts generate
- Failure scenario: Over-reading my own F-CA-04 numbers. The hub in my benchmark has in-degree 1,727 because the generator was built to produce one; the hub in the only real corpus has in-degree 3. If an agent-compiled KB turns out to have a FLAT degree distribution - plausible, because an agent writing pages under an editorial policy is not the growth process Barabasi-Albert models, and link fields are declared deliberately rather than accreted - then every hub-related cost I measured is an upper bound with no real instance behind it.
- Falsifiable proposal: State plainly in bench/scale-bench.ts that the degree distribution is ASSUMED, not observed, and that no accreta corpus large enough to test it exists. Wrong if accreta-atlas grows a KB whose in-degree distribution is fitted and found consistent with gamma~3 - at which point the generator is validated and F-CA-04 inherits its credibility.
- Cost to verify: 30 minutes to amend the comment.
- Confidence: high that the evidence is absent - I counted it. LOW on any claim about what real accreta graphs look like, which is the point of this finding.

## Experiment card: does an agent-compiled knowledge base have hubs?
- Question: Does the in-degree distribution of an agent-compiled KB exhibit the hub-and-tail shape bench/scale-bench.ts assumes, or is it closer to flat?
- Hypothesis: heavy-tailed but LESS skewed than preferential attachment predicts, because links are declared under an editorial policy rather than accreted by popularity - max in-degree between 5% and 15% of page count, against the 17% my gamma=3 generator produced at 10^4.
- Method: compile accreta-atlas's 8 RFCs into kb/knowledge/, 200-500 pages. Then SELECT dst_path, COUNT(*) c FROM links GROUP BY dst_path ORDER BY c DESC for the empirical distribution, and a LEFT JOIN for the leaf count. Fit the tail with the Clauset-Shalizi-Newman MLE plus the KS goodness-of-fit test, compare against log-normal - do not eyeball the log-log plot.
- Metric: fitted exponent gamma with CI, the KS p-value, and the ratio max-in-degree / page-count. That ratio, because it determines the worst case for findRelated and inbound closure.
- Falsification criterion: a KS p-value failing to reject log-normal in favour of power law, or a max-degree ratio below 5%, refutes the hub assumption and means bench/scale-bench.ts overstates hub costs.
- Cost: agent time to compile 200-500 pages; analysis under an hour.
- Not measured: whether one corpus generalises (n=1 on the process); how the distribution evolves as a corpus is MAINTAINED, since drift, supersession and re-verification all rewrite links.

## What I could not establish
- Whether the 10^5 superlinearity is algorithmic or memory pressure. The 1.36 slope rests on one run at 449MB index size. A GC or paging artifact would produce the same signature. Needs three runs at 10^5 with RSS and page-fault counts (~40 minutes), unaffordable at twelve minutes per run.
- Whether findCanonical's 1.45 slope holds past 10^4. It falls to 1.02 in the 10^4->10^5 row, the opposite of what an unindexed LIKE scan should do. Either the 10^3->10^4 point is noisy (timed with only 5 iterations) or the scan is memory-bandwidth-bound at both sizes.
- What real accreta graphs look like - F-CA-07, restated because it is the largest gap in my remit. Every hub-dependent number is conditioned on a generator, and the only real corpus is ten pages.
- Whether supersedes cycle detection is a traversal accreta needs. I measured it because the remit asked, but supersedes is in the vocabulary and nothing interprets it, so I could not establish whether cycle detection is a requirement or a hypothetical.
- The vendor-published recursive-SQL-vs-graph-native literature. I did NOT cite any, having found no peer-reviewed comparison whose setting resembles a 10^4-node embedded single-file database with no server. LDBC measures distributed and server-based systems at far larger scale and I could not honestly claim it transfers to bun:sqlite on a laptop. My own measurements are the better evidence and I would rather rest on them than on a citation that does not fit.
