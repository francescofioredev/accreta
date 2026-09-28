#!/usr/bin/env bun
/** Index the 9,842-page RFC knowledge base and weigh what an agent would get back. */
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildIndex,
  findRelated,
  getPage,
  lint,
  openIndex,
  parseConfig,
  searchPages,
} from "@accreta/core";
import { CONFIG_YAML, KB } from "../builders/rfc-kb.ts";
import { RESULTS } from "../lib/paths.ts";

const config = parseConfig(CONFIG_YAML);
const indexPath = join(KB, ".accreta", "index.sqlite");
mkdirSync(join(KB, ".accreta"), { recursive: true });
const builds = [0, 1, 2].map(() => buildIndex({ root: KB, config, indexPath }));
const db = openIndex(indexPath, { readonly: true });
const time = (fn: () => unknown) => {
  const t = performance.now();
  const v = fn();
  return { ms: performance.now() - t, v };
};
const search = time(() => searchPages(db, { query: "caching", limit: 20 }));
const page = time(() => getPage(db, "knowledge/rfc/rfc2616.md", config));
const related = time(() => findRelated(db, "knowledge/rfc/rfc2616.md", config, {}));
const report = time(() => lint(db, config));
const out = {
  pages: builds[0]!.pages,
  links: builds[0]!.links,
  build_ms: builds.map((b) => Math.round(b.ms)),
  index_bytes: statSync(indexPath).size,
  search_ms: +search.ms.toFixed(1),
  get_page_ms: +page.ms.toFixed(1),
  find_related_ms: +related.ms.toFixed(1),
  lint_ms: Math.round(report.ms),
  lint_findings: report.v.findings.length,
  lint_response_bytes: JSON.stringify(report.v).length,
  lint_kinds: Object.fromEntries(
    [...new Set(report.v.findings.map((f) => f.kind))].map((k) => [
      k,
      report.v.findings.filter((f) => f.kind === k).length,
    ]),
  ),
};
mkdirSync(RESULTS, { recursive: true });
writeFileSync(
  join(RESULTS, "r-t4-rfc-kb-scale.json"),
  JSON.stringify(
    { run_at: new Date().toISOString(), machine: `${process.platform} ${process.arch}`, ...out },
    null,
    1,
  ) + "\n",
);
console.log(out);
