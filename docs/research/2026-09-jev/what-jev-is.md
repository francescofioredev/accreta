# What Jev is

Jev is a model from TypeSafe AI, launched on 2026-09-15, which the vendor calls a "System One
model". It does not write text. It reads a **state** and answers a set of **typed questions**,
each with a probability distribution. The version measured here is `jev-1.13.0`, reached
through Cloudflare's Workers AI binding (`typesafe/jev`). TypeSafe paused direct sign-ups on its
own console, and Cloudflare, Vercel AI Gateway and OpenRouter resell it.

Every claim below carries an evidence grade, as in the
[August review](../2026-08-review/README.md): **MEASURED** (this study ran it), **CITED** (a
named source), **REASONED** (an argument, and the weakest).

## The interface

| | |
| --- | --- |
| Input | A `state`: a string, a JSON object or an array of text. Text only. **CITED**: [models](https://docs.typesafe.ai/models.md) |
| Questions | `noul`: P(yes). `choice`: up to 255 described options, with the full distribution. `score`: a rubric of 2–10 levels. Any number of questions per call over one state; TypeSafe documents no maximum. **CITED**: [API](https://docs.typesafe.ai/api.md) |
| Limits | "64k tokens per request; 32k tokens for `state` plus the longest question". **CITED**: [models](https://docs.typesafe.ai/models.md) |
| Price | $0.042 per million input tokens. Output tokens are not billed. **CITED**: [models](https://docs.typesafe.ai/models.md) |
| Latency | Vendor: 70–500 ms end to end. **CITED**: [launch post](https://typesafe.ai/blog/introducing-system-one-models-and-jev). This study: about 300–340 ms at p50 and 450–500 ms at p95, timed inside a Cloudflare Worker for single-question calls. **MEASURED** |
| Customisation | None on the weights: "Jev is not fine-tuned or LoRA-adapted with customer data". Everything is in the state, the instructions and the option descriptions. **CITED**: [models](https://docs.typesafe.ai/models.md) |
| Rationale | None. Every response in this study carries only the declared answers, their probabilities and token usage, never an explanation. **MEASURED** |

A request, as this study sends it:

```json
{ "state": { "rfc": "RFC9110: HTTP Semantics", "original": "…", "corrected": "…" },
  "questions": { "meaning_changed": { "type": "noul", "instructions": "Does the corrected text change …" } } }
```

## What its own documentation says it is bad at

**CITED**: [jaggedness, jev-1.13](https://docs.typesafe.ai/model-jaggedness/jev-1.13.md).
Each point is quoted because each one constrains where it can sit in accreta:

- **Distracting state:** "Accuracy falls as the state grows with content unrelated to the decision."
- **Literal reading:** it "answers the question you wrote, not the one you meant."
- **Counting:** it "does not count reliably".
- **Dates:** it "reads dates as text, not as ordered quantities". Revisions and timestamps are
  therefore off-limits.
- **Adversarial content:** it "does not treat it as hostile by default". This matters to
  accreta, whose [constitution](../../../templates/constitution/base.md) treats text in a page
  that addresses the agent as data.
- **Consistency across questions:** it does not guarantee "mathematical consistency between
  related questions". Packed calls can therefore contradict themselves.
- **Text:** it "is not trained to generate text".

## What the evidence about it is worth

- **The vendor's headline numbers.** "193.6x faster, 444.6x cheaper" come from four internal
  workflow evaluations, whose reference answers are the average of two frontier models, not
  human labels. The vendor's own launch post calls them "on the higher end of real world gains".
  **CITED**: [launch post](https://typesafe.ai/blog/introducing-system-one-models-and-jev).
- **Accuracy.** On those evaluations Jev agrees with the reference 67.8% of the time. The frontier
  models score 67.9–74.1%. **CITED**: [DataCamp's summary](https://www.datacamp.com/blog/system-one-models-jev).
- **"Zero hallucinations"** means zero schema errors: every answer is a declared option. It does
  not mean zero wrong answers. **CITED**: [launch post](https://typesafe.ai/blog/introducing-system-one-models-and-jev).
- **Independent tests before this study** were small and mostly on support tickets:
  - large speed and cost gains, accuracy close to small LLMs ([beese54](https://github.com/beese54/jev-ticket-triage),
    [arifulislamat](https://dev.to/arifulislamat/typesafes-jev-model-is-it-really-193x-faster-and-444x-cheaper-56oa));
  - one test found it confident on boundary cases it got wrong ([laya-jev-lab](https://github.com/yibie/laya-jev-lab)).
  
  None tested it on specifications or on code. **CITED**

## Responsibilities in accreta, if it had any

The table is REASONED from the interface above. The experiments in [`experiments/`](experiments/)
decide which rows survive.

| Jev could decide | Jev must never |
| --- | --- |
| Whether a changed passage invalidates a claim, as a triage in front of the agent's re-reading | Write, edit or delete a page, or bump `last_verified_revision` |
| Whether cited lines support a claim, as a lint finding | Resolve a contradiction between sources: it may flag one, never choose the winner |
| Which sections of a source are worth the writing model's attention | Be the only reader of a source: anything it skips must be recoverable, and the skip recorded |
| Which of a handful of search candidates answers a query, or which link to follow next | Replace the index. The index is the fallback and the ground every rerank starts from |
| — | Compare revisions or dates, count, or judge injected instructions. Its own documentation rules these out |

**The architectural consequence.** Today accreta never calls a model (the
[model-economist review](../2026-08-review/06-model-economist.md), F-ME-05). Any row in the left
column that survives the experiments reverses that decision, and has to be taken as an ADR, not
slipped in as a feature.
