# Decision-model benchmark

The harness behind [`docs/research/2026-09-jev/`](../../docs/research/2026-09-jev/README.md). It
asks whether a typed decision model (Jev, from TypeSafe AI) can take over the judgments accreta
currently leaves to the agent, and compares it with the deterministic step and with Claude
Haiku 4.5 on the same items.

## Layout

| Path | What it holds |
| --- | --- |
| `fetch/` | Downloads third-party data into `.external/` and checks it against `data/snapshots.json` |
| `builders/` | Deterministic dataset builders: errata, sections, cross-references, the RFC knowledge base, code units and drift facts, audit samples |
| `tasks/` | One file per task and tier: the questions, the protocol, the runner, the report |
| `data/` | Datasets, labels and audit samples: ids, splits, hashes. **Committed before any model sees them** |
| `results/` | One row per item per arm, committed, so every figure in the cards can be recomputed |
| `proxy/` | A Cloudflare Worker that holds the Workers AI binding, so the harness holds no credentials |
| `audit.ts` | The blind audit, in the terminal |
| `report.ts` | Regenerates every generated table and chart in the cards |

Not committed: `.external/` (third-party data, reproducible from `fetch/`) and `.cache/` (the call
cache, keyed by the full request, so a rerun of a finished task makes no calls).

## Running it

```bash
bun bench/jev/fetch/rfc.ts
rsync -az rsync.rfc-editor.org::rfcs-text-only/ bench/jev/.external/rfc/all/
bun bench/jev/fetch/scifact.ts

# Jev, through Cloudflare: needs `wrangler login` on an account with AI Gateway credits.
wrangler dev --config bench/jev/proxy/wrangler.jsonc --port 8799

bun bench/jev/tasks/run-t3.ts                         # drift triage, RFC errata
bun bench/jev/tasks/run-t3-ladder.ts --stage=ladder   # context ladder; then haiku, l3, batch
bun bench/jev/tasks/run-t2-scifact.ts                 # citation support, SciFact
bun bench/jev/tasks/run-t1.ts --stage=jev             # ingest triage, RFC sections
bun bench/jev/tasks/run-t4.ts                         # navigation and rerank, 9,842-page KB
bun bench/jev/tasks/ingest-atlas.ts                   # tier A baseline ingest (Claude Code)
bun bench/jev/tasks/ingest-got.ts                     # tier C baseline ingest (Claude Code)
bun bench/jev/report.ts
```

Haiku, Opus and Sonnet calls go through the `claude` CLI in `--safe-mode` from a directory outside
the repository, so no project instructions leak into them. The CLI adds a fixed system prompt of
about 1,300 tokens and Haiku's reasoning. That makes its latency and cost an upper bound on what
the API would charge for the same question; the cards say so wherever they compare costs.

## Cost of a full run, 2026-09-28

Measured, summed from `results/` and the call cache:

- **Jev:** $1.17 of Cloudflare AI Gateway credit, for every task and tier.
- **Claude models:** $70.85 at list prices.
  - $17.35 is the nine baseline ingest sessions.
  - $53.50 is every CLI decision: Haiku arms, Opus annotators, Sonnet writers.
  - All of it ran on a Claude subscription seat rather than metered credit.
