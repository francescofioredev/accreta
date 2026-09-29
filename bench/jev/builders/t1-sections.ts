#!/usr/bin/env bun
/**
 * T1, tier R: sections of heavily cited RFCs, labelled by whether another RFC cites them by number.
 * Targets are chosen by rule, not by hand; the calibration/test split is by RFC, so no document
 * contributes to both.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sha256 } from "../lib/cache.ts";
import { DATA, EXTERNAL } from "../lib/paths.ts";
import { shuffle } from "../lib/rng.ts";
import { splitRfc } from "../lib/sections.ts";

export const RULE = {
  min_distinct_citing_rfcs: 10,
  targets: 20,
  calibration_targets: 5,
  // A heading with no body of its own (a parent of subsections) is not a unit an agent reads.
  min_section_chars: 200,
  seed: 20261001,
} as const;

export interface T1Item {
  id: string;
  rfc: string;
  split: "calibration" | "test";
  number: string;
  title: string;
  start: number;
  end: number;
  chars: number;
  cited_by: string[];
  label: boolean;
  text_sha256: string;
}

export const rfcFile = (rfc: string) =>
  join(EXTERNAL, "rfc", "all", `rfc${Number(rfc.replace("RFC", ""))}.txt`);

if (import.meta.main) {
  const { cited } = JSON.parse(readFileSync(join(DATA, "crossrefs.json"), "utf8")) as {
    cited: Record<string, Record<string, string[]>>;
  };
  const ranked = Object.entries(cited)
    .map(([rfc, secs]) => ({
      rfc,
      sections: Object.keys(secs).length,
      citing: new Set(Object.values(secs).flat()).size,
    }))
    .filter((r) => r.citing >= RULE.min_distinct_citing_rfcs)
    .sort((a, b) => b.sections - a.sections || a.rfc.localeCompare(b.rfc))
    .slice(0, RULE.targets);
  const calibration = new Set(
    shuffle(
      ranked.map((r) => r.rfc),
      RULE.seed,
    ).slice(0, RULE.calibration_targets),
  );
  const items: T1Item[] = [];
  for (const { rfc } of ranked) {
    for (const s of splitRfc(readFileSync(rfcFile(rfc), "latin1"))) {
      if (s.text.length < RULE.min_section_chars) continue;
      if (/references|acknowledg|authors?'? address|contributors|full copyright/i.test(s.title))
        continue;
      const by = cited[rfc]?.[s.number] ?? [];
      items.push({
        id: `${rfc}#${s.number}`,
        rfc,
        split: calibration.has(rfc) ? "calibration" : "test",
        number: s.number,
        title: s.title,
        start: s.start,
        end: s.end,
        chars: s.text.length,
        cited_by: by,
        label: by.length > 0,
        text_sha256: sha256(s.text),
      });
    }
  }
  const stats = (split: string) => {
    const xs = items.filter((i) => i.split === split);
    return {
      rfcs: new Set(xs.map((i) => i.rfc)).size,
      sections: xs.length,
      positive: xs.filter((i) => i.label).length,
      chars: xs.reduce((s, i) => s + i.chars, 0),
    };
  };
  writeFileSync(
    join(DATA, "t1-sections.json"),
    JSON.stringify({ rule: RULE, targets: ranked, items }) + "\n",
  );
  console.log(
    ranked
      .map((r) => `${r.rfc}(${r.sections}/${r.citing})${calibration.has(r.rfc) ? "*" : ""}`)
      .join(" "),
  );
  console.log({ calibration: stats("calibration"), test: stats("test") });
}
