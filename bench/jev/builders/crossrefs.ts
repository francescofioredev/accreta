#!/usr/bin/env bun
/**
 * Mine "Section N of RFC X" citations across the whole RFC series. A section another RFC's
 * authors chose to cite is a section a reader would cite: T1's natural label.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA, EXTERNAL } from "../lib/paths.ts";

const DIR = join(EXTERNAL, "rfc", "all");
const SEC = String.raw`(?:Section|Sections|Sec\.|Appendix)\s+((?:\d+|[A-Z])(?:\.\d+)*)`;
const REF = String.raw`(?:\[RFC\s?(\d{1,4})\]|RFC\s?(\d{1,4}))`;
const PATTERNS = [new RegExp(`${SEC}\\s+of\\s+${REF}`, "g"), new RegExp(`${REF},?\\s+${SEC}`, "g")];

export interface CrossRefs {
  /** target RFC -> section number -> citing RFCs */
  cited: Record<string, Record<string, string[]>>;
}

if (import.meta.main) {
  const cited: CrossRefs["cited"] = {};
  const files = readdirSync(DIR).filter((f) => /^rfc\d+\.txt$/.test(f));
  for (const f of files) {
    const citing = `RFC${Number(f.slice(3, -4))}`;
    const text = readFileSync(join(DIR, f), "latin1").replace(/\s+/g, " ");
    for (const re of PATTERNS) {
      for (const m of text.matchAll(re)) {
        const [section, target] =
          re === PATTERNS[0] ? [m[1]!, m[2] ?? m[3]!] : [m[3]!, m[1] ?? m[2]!];
        const t = `RFC${Number(target)}`;
        if (t === citing) continue;
        const bySection = (cited[t] ??= {});
        const list = (bySection[section.replace(/\.$/, "")] ??= []);
        if (!list.includes(citing)) list.push(citing);
      }
    }
  }
  writeFileSync(join(DATA, "crossrefs.json"), JSON.stringify({ cited }) + "\n");
  const ranked = Object.entries(cited)
    .map(
      ([t, s]) =>
        [t, Object.keys(s).length, Object.values(s).reduce((a, x) => a + x.length, 0)] as const,
    )
    .sort((a, b) => b[1] - a[1]);
  console.log(files.length, "RFCs scanned;", ranked.length, "RFCs cited by section");
  console.log(
    ranked
      .slice(0, 30)
      .map((r) => `${r[0]}:${r[1]} sections/${r[2]} citations`)
      .join("  "),
  );
}
