#!/usr/bin/env bun
/**
 * T4, tier R: a knowledge base with one page per RFC, built deterministically from the RFC Editor's
 * index. Obsoletes/obsoleted-by become typed supersedes/superseded_by links, updates become related.
 * No model writes anything, so the graph is exactly the one the IETF published. Written to .external/.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA, EXTERNAL } from "../lib/paths.ts";
import { rfcIndex } from "../lib/rfc-index.ts";

export const KB = join(EXTERNAL, "rfc-kb");
export const CONFIG_YAML = `knowledge_base: knowledge
page_types: [source]
link_fields: [supersedes, superseded_by, related]
`;

const slug = (id: string) => `rfc${Number(id.replace("RFC", ""))}`;
const link = (ids: string[], index: Map<string, unknown>) =>
  ids.filter((i) => index.has(i)).map((i) => `[[rfc/${slug(i)}]]`);
const yamlList = (xs: string[]) => (xs.length ? xs.join(", ") : "[]");
const q = (s: string) => JSON.stringify(s);

if (import.meta.main) {
  const index = rfcIndex();
  const revision = JSON.parse(readFileSync(join(DATA, "snapshots.json"), "utf8"))[
    "index.xml"
  ].sha256.slice(0, 40);
  rmSync(KB, { recursive: true, force: true });
  mkdirSync(join(KB, "knowledge", "rfc"), { recursive: true });
  writeFileSync(join(KB, "accreta.config.yaml"), CONFIG_YAML);
  let links = 0;
  for (const e of index.values()) {
    const supersedes = link(e.obsoletes, index);
    const supersededBy = link(e.obsoletedBy, index);
    const related = link([...e.updates, ...e.updatedBy], index);
    links += supersedes.length + supersededBy.length + related.length;
    const n = Number(e.id.replace("RFC", ""));
    const page = `---
type: source
title: ${q(`RFC ${n}: ${e.title}`)}
aliases: [${q(`RFC ${n}`)}, ${q(e.id)}]
source: rfc-series
canonical_source: ${q(`rfc-series:${slug(e.id)}.txt#L1`)}
last_verified_revision: ${q(revision)}
supersedes: ${yamlList(supersedes)}
superseded_by: ${yamlList(supersededBy)}
related: ${yamlList(related)}
---

# RFC ${n}: ${e.title}

Status: ${e.status}. Published ${e.date}.${e.keywords.length ? ` Keywords: ${e.keywords.join(", ")}.` : ""}

${e.abstract || "No abstract in the RFC index."}
`;
    writeFileSync(join(KB, "knowledge", "rfc", `${slug(e.id)}.md`), page);
  }
  const isolated = [...index.values()].filter(
    (e) => !e.obsoletes.length && !e.obsoletedBy.length && !e.updates.length && !e.updatedBy.length,
  ).length;
  console.log({
    pages: index.size,
    links,
    isolated,
    isolated_share: (isolated / index.size).toFixed(3),
  });
}
