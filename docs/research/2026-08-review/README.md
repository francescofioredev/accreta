# Review, August 2026

These are findings, not decisions. A decision is an ADR.

The distinction matters enough to state at the top of the directory, because the two are
easy to confuse and the confusion is expensive. `docs/adr/` records what the project has
decided and why, including what it rejected. This directory records what a review found —
some of it confirmed, some of it plausible and unresolved, some of it wrong. Nothing here
binds anyone. Where a finding was ripe enough to become a decision, there is an ADR, and
the finding says so.

## Why this review happened

accreta reached v0.1.2 with six roadmap phases marked done, a green test suite and five
ADRs. That is a good position from which to ask an uncomfortable question: the project's
own rule is _no claim without a measurement_, and several of its most structural claims
had never been measured. There was no scaling curve. The MCP tool responses had never been
weighed. Two numbers for the same rebuild disagreed with each other, one in ADR-0004 and
one in `.gitignore`.

So the review was built to be critical by construction rather than by good intentions.
Six reviewers, each with one disciplinary lens and no sight of the others' work, followed
by an adversarial verifier whose only job was to try to break what they produced — to open
every cited line, check every cited paper, and reject what did not survive.

A seventh reviewer was added afterwards, at the maintainer's request, to cover the largest
gap the first six left: all of them assumed the corpus was benign. That assumption is fair
for a local single-user tool and poor for the remote deployment the MCP server exists to
serve, where a knowledge base has contributors who are not the operator.

## The rule the reviewers worked under

Every finding carries an evidence grade, and there are only three:

- **MEASURED** — someone ran it, and reported the numbers, the command and the machine.
- **CITED** — a paper, a standard or a named study, with the specific result relied upon.
- **REASONED** — an argument from the code, with the file and line. The weakest grade, and
  a finding that reaches only this must say so.

Anything the verifier could not confirm was downgraded. Anything it could not confirm at
all was rejected. "Best practice" was a banned phrase, because it is what a claim says
when it has no evidence behind it.

The ADRs were explicitly in scope. They were read as hypotheses that had been accepted,
not as constraints — the only things held fixed were the three constitutional properties
(citation with revision, recorded verification, recorded contradiction) and the two
engineering invariants that follow from them (the core never branches on adapter identity;
markdown is the source of truth).

## What is here

| File             | What it is                                                               |
| ---------------- | ------------------------------------------------------------------------ |
| `00-register.md` | Every surviving finding, ranked, with its verdict and where it went      |
| `01`–`07`        | The reviewers' reports, one per lens                                     |
| `experiments/`   | Measurements that were designed but not run, with falsification criteria |

Two benchmarks were written for this review and live with the others: `bench/scale-bench.ts`
and `bench/mcp-budget.ts`. Their numbers are in the register and in the reports that rest
on them.
