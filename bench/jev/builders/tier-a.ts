#!/usr/bin/env bun
/**
 * Tier A: what the baseline ingest cited. Every footnote citation into RFC 9111 or 6455, with the
 * sentence that carries it, and a per-section label: did any run (and did at least two runs) cite
 * a line inside the section? Also compares that label with tier R's proxy on the same sections.
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA } from "../lib/paths.ts";
import { splitRfc } from "../lib/sections.ts";
import { cohenKappa } from "../lib/stats.ts";
import { RUNS, RUNS_DIR, TARGETS } from "../tasks/ingest-atlas.ts";

export interface Citation {
  run: number;
  page: string;
  footnote: string;
  rfc: string;
  start: number;
  end: number;
  claim: string;
}

const CITE =
  /^\[\^([^\]]+)\]:\s*(rfc-[a-z]+) @ [0-9a-f]+ · (kb\/corpus\/rfc\/rfc(\d+)\.txt)#L(\d+)(?:-L(\d+))?/;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) =>
    statSync(join(dir, f)).isDirectory()
      ? walk(join(dir, f))
      : f.endsWith(".md")
        ? [join(dir, f)]
        : [],
  );
}

/** The sentence(s) in the body that reference a footnote, with footnote markers stripped. */
function claimsFor(body: string, name: string): string[] {
  const marker = `[^${name}]`;
  return body
    .split(/\n\s*\n/)
    .filter((para) => para.includes(marker) && !para.trimStart().startsWith("[^"))
    .flatMap((para) => para.replace(/\s+/g, " ").split(/(?<=[.!?])\s+(?=[A-Z`*"(])/))
    .filter((s) => s.includes(marker))
    .map((s) => s.replace(/\[\^[^\]]+\]/g, "").trim());
}

if (import.meta.main) {
  const citations: Citation[] = [];
  for (let run = 1; run <= RUNS; run++) {
    const kb = join(RUNS_DIR, `run${run}`, "kb", "knowledge");
    for (const file of walk(kb)) {
      const text = readFileSync(file, "utf8");
      const body = text.replace(/^---[\s\S]*?---/, "");
      for (const line of body.split("\n")) {
        const m = line.match(CITE);
        if (!m) continue;
        const start = Number(m[5]);
        for (const claim of claimsFor(body, m[1]!)) {
          citations.push({
            run,
            page: file.slice(kb.length + 1),
            footnote: m[1]!,
            rfc: `RFC${m[4]}`,
            start,
            end: Number(m[6] ?? start),
            claim,
          });
        }
      }
    }
  }
  const { cited: crossrefs } = JSON.parse(readFileSync(join(DATA, "crossrefs.json"), "utf8"));
  const sections = TARGETS.flatMap((t) => {
    const text = readFileSync(join(RUNS_DIR, "run1", t.path), "latin1");
    return splitRfc(text)
      .filter(
        (s) =>
          s.text.length >= 200 &&
          !/references|acknowledg|authors?'? address|contributors|full copyright/i.test(s.title),
      )
      .map((s) => {
        const runs = new Set(
          citations
            .filter((c) => c.rfc === t.rfc && c.start <= s.end && c.end >= s.start)
            .map((c) => c.run),
        );
        return {
          id: `${t.rfc}#${s.number}`,
          rfc: t.rfc,
          number: s.number,
          title: s.title,
          start: s.start,
          end: s.end,
          chars: s.text.length,
          runs_citing: runs.size,
          label_any: runs.size >= 1,
          label_majority: runs.size >= 2,
          cited_by_other_rfcs: (crossrefs[t.rfc]?.[s.number] ?? []).length,
        };
      });
  });
  const kappa = cohenKappa(
    sections.map((s) => String(s.label_majority)),
    sections.map((s) => String(s.cited_by_other_rfcs > 0)),
  );
  writeFileSync(
    join(DATA, "tier-a.json"),
    JSON.stringify({ citations, sections, proxy_agreement: { kappa } }) + "\n",
  );
  const pos = (k: "label_any" | "label_majority") => sections.filter((s) => s[k]).length;
  console.log({
    citations: citations.length,
    per_run: [1, 2, 3].map((r) => citations.filter((c) => c.run === r).length),
    sections: sections.length,
    cited_any: pos("label_any"),
    cited_majority: pos("label_majority"),
    cited_by_other_rfcs: sections.filter((s) => s.cited_by_other_rfcs > 0).length,
    proxy_kappa: kappa.toFixed(3),
  });
}
