# The npm download count is not an adoption number

> A finding, not a decision. August 2026, measured against the window 8–24 August.
> Reproduce it with `bun run adoption`.

npm reported 1,836 downloads across the five published packages in the eighteen days after
the first release. The number invites one reading and supports another: it is automation
almost in its entirety, and there is no evidence of a single human user.

This is written down because the number will keep growing, every future release will produce
another spike, and the question deserves an answer that does not have to be reconstructed
from four APIs each time it is asked.

## What was measured

| | accreta | @core | @mcp-server | @adapter-fs | @adapter-git |
|---|---|---|---|---|---|
| 8 Aug — 0.1.1 published | 105 | 124 | 54 | 57 | 64 |
| 9 Aug — 0.1.2 published | 165 | 204 | 170 | 196 | 199 |
| 10–24 Aug, fifteen days | 88 | 127 | 98 | 95 | 90 |
| **total** | **358** | **455** | **322** | **348** | **353** |

1,338 of the 1,836 — 73% — landed on the two publish days.

## Four signals, none of them human

**The spike is the publish.** Zero downloads on 7 August. 0.1.1 went out at 13:12 UTC on the
8th and 0.1.2 at 17:27 UTC on the 9th, and the two peaks sit exactly there. Nothing
announced the package on either day; nothing could have.

**The counts contradict the dependency graph.** This is the one that does not depend on
interpretation. `accreta` and `@accreta/mcp-server` are the only packages anyone installs on
purpose, and both require core, adapter-fs and adapter-git. An install fetches the tree, so
each of those three must be counted at least 358 + 322 = 680 times. Measured: 455, 348, 353
— shortfalls of 225, 332 and 327. A warm npm cache moves counts down, not up, but it cannot
account for a gap that large across the whole window, and it cannot produce the shape at
all: five packages fetched about equally often, one per package, which is what a crawler
enumerating a registry does and what dependency resolution never does.

**Nobody visited the repository.** GitHub traffic over the fourteen days it keeps: 31 views
from 13 unique visitors, sole referrer `github.com` at one unique visitor, and the most-read
paths were this repository's own pull requests. Against that, 252 clones from 88 unique
sources. Clones without views are not readers.

**Nothing depends on it.** ecosyste.ms reports zero dependent repositories and zero
dependent packages for all five. GitHub code search for `accreta` returns the obstetric
condition and no `package.json`.

## The published baselines

Both thresholds the report compares against are cited rather than assumed:

- Tenable, documenting download pumping, measures **100–150 automated downloads per
  published version** from mirrors, analysis bots and security scanners. Two versions across
  five packages predicts 1,000–1,500, against an observed publish-day total of 1,338.
  [Source](https://www.tenable.com/blog/how-cyberattackers-inflate-malicious-package-npm-download-counts)
- npm describes its own counters as **naive by design**, with no effort spent filtering
  automated traffic. [Source](https://blog.npmjs.org/post/92574016600/numeric-precision-matters-how-npm-download-counts-work.html)
  Away from a publish, these packages run at 5.9–8.5 downloads per day.

## What would change the answer

`bun run adoption` prints these three as a checklist, so a future reading does not need this
page to interpret it. None of them is true today:

1. a sustained rate at or above 50/day for any package;
2. a repository that depends on any of the five;
3. a referrer to the repository other than `github.com`.

An API that fails to answer prints `?`, never `no`. A source that did not reply is not
evidence of absence.

## What this does not say

It does not say the packages are unused — only that nothing observable says they are used,
which is the expected state for a project eighteen days old that has never been announced.
Nor does it say anything about whether the work is worth doing. It settles one question: the
download counter is not evidence, and no decision should rest on it.
