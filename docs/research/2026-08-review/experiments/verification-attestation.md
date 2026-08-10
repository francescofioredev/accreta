# Does a verification claim survive contact with an agent?

**Status:** designed, not run. Blocked on a knowledge base existing — `accreta-atlas/kb/knowledge/`
is deliberately empty and `sessions/` does not yet exist on disk.

## The question

`last_verified_revision` records that a check happened. It does not record who made it, when,
or by what method. A verification performed by a model that read three hundred lines carefully
and one performed by a model that skimmed a filename produce byte-identical frontmatter.

The constitution names bumping that field without re-reading as "the single most damaging thing
you can do here" — and the system has no way to tell whether it happened. Worse, the failure is
invisible in exactly the way that looks like success: lint reports nothing, drift reports
nothing, CI is green, and the green CI is _evidence to the user_ that the shortcut was not taken.

So: if verification carried an attestation, would agents populate it honestly?

## Why the obvious objection is right, and what remains

A self-reported `last_verified_by` is trivially forgeable. It does not make verification
trustworthy, and claiming otherwise would be exactly the overclaiming this project treats as its
characteristic failure.

What it buys is narrower and real: it makes the _population_ auditable. A reviewer can ask
"which pages were verified by which agent, in which session, and did that session actually read
the source?" — and cross-reference the transcript. That converts an unanswerable question into a
checkable one.

The companion field `last_verified_at` is the load-bearing half, because it makes trust decay
expressible. A verification ages even when the source does not. The atlas corpus proves it: RFC
7231's bytes are frozen forever, so drift will report it current forever, while the document was
obsoleted in 2022. "Verified at revision R" and "verified recently" are different assurances, and
the system currently offers only the first while its green CI implies the second.

## Method

1. Patch `update_verified_revision` to write three fields rather than one:
   `last_verified_revision`, `last_verified_at`, `last_verified_by`. `setFrontmatterField`
   already takes a field name, so this generalises without new machinery.
2. Run one full ingest batch over the atlas RFC corpus, with an agent following the constitution
   as shipped.
3. For every page claiming verification, check the session transcript for whether the source file
   was actually read in that session.

## Metric

**The proportion of verification claims corroborated by a matching source read in the same
transcript.** That number and not a count of populated fields, because a populated field measures
which code path was used, not whether reading happened. Corroboration is the only external check
available on a self-reported value — it is the difference between an attestation and a
decoration.

## Falsification

At or above ~95% corroboration, unattested verification is not a real problem in practice and the
finding behind this card is over-stated: the fields buy nothing worth their weight.

Below ~70%, the attestation is necessary _and insufficient_, and the honest response is not to
trust the field but to make the tool the only sanctioned path.

Between those, it is a live question and the fields earn their place as an audit surface.

## Cost

About six hours, one ingest batch of agent time. The blocker is not cost — it is that no
knowledge base exists to run it against.

## What this does not measure

Adversarial behaviour. An agent under context pressure, or one that has learned the field is
checked, may behave differently from one in an observed batch. This measures the cooperative
case, which is the optimistic bound — and the failure mode of concern is precisely the one that
appears under pressure.
