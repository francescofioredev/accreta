#!/usr/bin/env bun
/**
 * T3, tier R: verified RFC errata as drift items. The IETF classified each one as Technical
 * (the original text was technically wrong) or Editorial (spelling, grammar, punctuation or
 * syntax that does not change technical meaning) — a human label made before any model saw it.
 * Writes data/t3-errata.json: ids, split, label and text hashes; the texts come from the snapshot.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fetchPinned, FEEDS } from "../fetch/rfc.ts";
import { sha256 } from "../lib/cache.ts";
import { DATA } from "../lib/paths.ts";
import { shuffle } from "../lib/rng.ts";

export const SEED = 20260927;
export const PER_CLASS = { calibration: 100, test: 400 } as const;
const MAX_CHARS = 8000;
const MAX_PER_RFC = 2;

export interface Erratum {
  errata_id: string;
  "doc-id": string;
  errata_status_code: string;
  errata_type_code: string;
  section: string | null;
  orig_text: string | null;
  correct_text: string | null;
}

export interface T3Item {
  id: string;
  rfc: string;
  section: string;
  label: "technical" | "editorial";
  split: "calibration" | "test";
  orig_sha256: string;
  correct_sha256: string;
}

const squash = (s: string) => s.replace(/\s+/g, " ").trim();

export async function loadErrata(): Promise<Map<string, Erratum>> {
  const all: Erratum[] = JSON.parse(
    readFileSync(await fetchPinned("errata.json", FEEDS.errata), "utf8"),
  );
  return new Map(all.map((e) => [e.errata_id, e]));
}

if (import.meta.main) {
  const errata = [...(await loadErrata()).values()];
  const eligible = errata.filter(
    (e) =>
      e.errata_status_code === "Verified" &&
      (e.errata_type_code === "Technical" || e.errata_type_code === "Editorial") &&
      e.orig_text?.trim() &&
      e.correct_text?.trim() &&
      e.orig_text !== e.correct_text &&
      e.orig_text.length + e.correct_text.length <= MAX_CHARS,
  );
  const seen = new Set<string>();
  const items: T3Item[] = [];
  const excluded = { duplicate: 0, rfc_cap: 0 };
  for (const cls of ["Technical", "Editorial"] as const) {
    const perRfc = new Map<string, number>();
    const picked: Erratum[] = [];
    for (const e of shuffle(
      eligible.filter((x) => x.errata_type_code === cls),
      SEED,
    )) {
      const key = `${e["doc-id"]}\0${squash(e.orig_text!)}\0${squash(e.correct_text!)}`;
      if (seen.has(key)) {
        excluded.duplicate++;
        continue;
      }
      if ((perRfc.get(e["doc-id"]) ?? 0) >= MAX_PER_RFC) {
        excluded.rfc_cap++;
        continue;
      }
      seen.add(key);
      perRfc.set(e["doc-id"], (perRfc.get(e["doc-id"]) ?? 0) + 1);
      picked.push(e);
      if (picked.length === PER_CLASS.calibration + PER_CLASS.test) break;
    }
    picked.forEach((e, i) =>
      items.push({
        id: e.errata_id,
        rfc: e["doc-id"],
        section: e.section ?? "",
        label: cls === "Technical" ? "technical" : "editorial",
        split: i < PER_CLASS.calibration ? "calibration" : "test",
        orig_sha256: sha256(e.orig_text!),
        correct_sha256: sha256(e.correct_text!),
      }),
    );
  }
  const counts = {
    eligible: {
      technical: eligible.filter((e) => e.errata_type_code === "Technical").length,
      editorial: eligible.filter((e) => e.errata_type_code === "Editorial").length,
    },
    excluded,
    sampled: items.length,
  };
  writeFileSync(
    join(DATA, "t3-errata.json"),
    JSON.stringify(
      {
        seed: SEED,
        per_class: PER_CLASS,
        max_chars: MAX_CHARS,
        max_per_rfc: MAX_PER_RFC,
        counts,
        items,
      },
      null,
      1,
    ) + "\n",
  );
  console.log(counts, new Set(items.map((i) => i.rfc)).size, "distinct RFCs");
}
