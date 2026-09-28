# T1: ingest triage

## 1. Question

Before an agent reads a source to write pages, can a decider pick out the sections worth reading
well enough that skipping the rest loses almost nothing a reader would cite?

## 2. Hypothesis and falsification

Ingest is the expensive phase. An agent reads the whole source, and the 8 RFCs in accreta-atlas
alone are about 423k input tokens. Yet the [constitution](../../../../templates/constitution/base.md)
says most of a source does not deserve a page. If a cheap decider can say which sections do,
the writing model reads only those. The risk is a silent miss: a section skipped is knowledge
the knowledge base never gets, and nothing flags it.

**H1.** At a threshold fixed on separate RFCs, the decider keeps at least 95% of the sections
other RFCs cite, while skipping at least 30% of the text.

- **Refuted** if recall on the test RFCs falls below 95%, or if under 30% of characters are skipped.
- **Demonstrated** only if the lower bound of the recall interval is also at least 90%.

**H2 (descriptive).** Jev compared with Haiku and with two deterministic scores: the count of
RFC 2119 keywords, and section length.

## 3. Pre-registration

- **Label.** A section is **cited** if at least one *other* RFC cites it by number ("Section 4.2
  of RFC 3261", "[RFC3261], Section 4.2"), mined from the whole RFC series
  (`bench/jev/builders/crossrefs.ts`).
  - This is a proxy for "worth a page". Other authors chose these sections to point at, before this
    study existed.
  - The proxy is checked against tier A's ingest labels once they exist.
- **Targets, by rule** (`bench/jev/builders/t1-sections.ts`). RFCs with at least 10 distinct citing
  RFCs, ranked by the number of distinct sections cited; the top 20.
  - The rule on distinct citing RFCs keeps out documents that only a successor cites section by
    section.
  - Sections under 200 characters (bare parent headings) are excluded, as are references,
    acknowledgements and author addresses.
- **Split by RFC** (seed 20261001): 5 calibration RFCs, 15 test RFCs, so no document contributes to both.
- **Levels:**
  - **S0:** the section alone, with RFC and section title.
  - **S1:** S0 plus the RFC abstract.
  - **S2:** S1 plus the RFC's table of contents.
  - **P, packed:** consecutive whole sections of one RFC, up to 60,000 characters, as one state,
    with one question per section. This is the "one document, many questions" shape TypeSafe's
    documentation recommends.
- **Selection.** The level with the best AUROC on the calibration RFCs, with ties going to fewer tokens.
  The test RFCs are scored once at that level; the others are reported as exploratory.
- **Threshold rule.** A section is read when its score ≥ τ. τ is the largest value keeping recall of
  cited sections at or above 95% on the calibration RFCs.
- **Haiku** runs at the selected level. If that level is per-section, it runs on the calibration
  RFCs and a seeded sample of 600 test sections.

## 4. Setup

The question, a `noul`:

> Would another specification, or a technical documentation page about this protocol, need to
> cite this section specifically, because it defines a rule, a message or data format, a
> procedure, a value, an error condition or a term that others depend on? Introductions,
> overviews, motivation, examples that only restate other sections, and administrative text are
> not cited this way.

In the packed level, each question is prefixed "About section N ("title") only:".

## 5. Dataset

- **Target RFCs** (distinct sections cited / distinct citing RFCs), calibration marked \*:
  3261 (108/96), 6350 (80/16), 7252\* (75/39), 7231 (72/53), 2616\* (64/46),
  6325 (63/30), 7285 (63/13), 5661 (62/14), 8446 (62/53), 7230 (58/46),
  5280\* (56/102), 4340\* (53/12), 5545 (51/15), 3986 (49/164), 4861 (48/58),
  7296\* (48/28), 3315 (47/55), 4271 (45/49), 6749 (42/28), 3550 (40/71).
- **Calibration:** 5 RFCs, 696 sections, 285 cited.
- **Test:** 15 RFCs, 2,267 sections, 826 cited, about 4.4M characters.

## 6. Metrics and why these

- **Recall of cited sections at τ**, the gated error: a miss is silent.
- **Characters skipped**, the reading saved. This is the number that turns into ingest cost.
- **AUROC**, and the full recall-versus-skipped curve over every threshold.
- **Latency per call and questions per call.** In the packed level one call answers many sections.
- **Cost per 1,000 sections.**

## 7. Results

### Tier R

<!-- report:t1-r -->
<!-- /report:t1-r -->

## 8. What this does and does not show

_To be completed with the results._

## 9. Reproduce

```bash
bun bench/jev/fetch/rfc.ts
rsync -az rsync.rfc-editor.org::rfcs-text-only/ bench/jev/.external/rfc/all/
bun bench/jev/builders/crossrefs.ts
bun bench/jev/builders/t1-sections.ts
wrangler dev --config bench/jev/proxy/wrangler.jsonc --port 8799
bun bench/jev/tasks/run-t1.ts --stage=jev
bun bench/jev/tasks/run-t1.ts --stage=haiku
bun bench/jev/report.ts
```

## 10. Run log

| Date | Commit | What | Outcome |
| --- | --- | --- | --- |
| 2026-09-28 | _pre-registration_ | Cross-references, targets, sections, levels, question and protocol committed | — |
