/**
 * T4, tier R. Question: can a decider find the page a query asks for by reading pages and choosing
 * links, where lexical search alone fails? Arms: BM25; BM25 top-20 reranked in one call; navigation
 * from BM25's top hit along typed links. Pre-registered before any model sees the queries.
 */
import {
  findRelated,
  getPage,
  openIndex,
  parseConfig,
  searchPages,
  type Database,
} from "@accreta/core";
import { join } from "node:path";
import { CONFIG_YAML, KB } from "../builders/rfc-kb.ts";
import type { Questions } from "../lib/questions.ts";

export const PROTOCOL = {
  rerank_candidates: 20,
  max_hops: 4,
  summary_chars: 600,
  metrics: "recall@1 and recall@5 per class; navigation reports success@1 and hops",
} as const;

const STOP = new Set(
  "the a an of to in on at by for with and or is are was be how what which that this it its do does can i you we my there from into as not".split(
    " ",
  ),
);

/** Quote every term and OR them: the most permissive FTS5 reading, and immune to query syntax. */
export const ftsQuery = (q: string) =>
  [...new Set(q.toLowerCase().match(/[a-z0-9][a-z0-9.\-/]*[a-z0-9]|[a-z0-9]/g) ?? [])]
    .filter((t) => t.length > 1 && !STOP.has(t))
    .map((t) => `"${t}"`)
    .join(" OR ");

export function openKb(): { db: Database; config: ReturnType<typeof parseConfig> } {
  return {
    db: openIndex(join(KB, ".accreta", "index.sqlite"), { readonly: true }),
    config: parseConfig(CONFIG_YAML),
  };
}

export const bm25 = (db: Database, query: string, limit: number) =>
  searchPages(db, { query: ftsQuery(query), limit }).map((h) => h.path);

export function summary(db: Database, config: ReturnType<typeof parseConfig>, path: string) {
  const p = getPage(db, path, config);
  return {
    title: p?.title ?? path,
    summary: (p?.body ?? "")
      .replace(/^#.*\n/, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, PROTOCOL.summary_chars),
  };
}

export function rerankCall(
  db: Database,
  config: ReturnType<typeof parseConfig>,
  query: string,
  candidates: string[],
) {
  const state = {
    query,
    candidates: candidates.map((path, i) => ({ id: `c${i + 1}`, ...summary(db, config, path) })),
  };
  const questions: Questions = {};
  candidates.forEach((_, i) => {
    questions[`c${i + 1}`] = {
      type: "noul",
      instructions: `Is candidate c${i + 1} the specification the query asks for?`,
    };
  });
  return { state, questions };
}

/** One navigation step: stay here, or follow one of the page's outgoing typed links. */
export function hopCall(
  db: Database,
  config: ReturnType<typeof parseConfig>,
  query: string,
  path: string,
  visited: Set<string>,
) {
  const links = findRelated(db, path, config, {}).relations.filter(
    (r) => r.direction === "outbound" && !visited.has(r.path),
  );
  const criteria: Record<string, string> = {
    here: "this page is the specification the query asks for",
  };
  links.slice(0, 254).forEach((l, i) => {
    criteria[`l${i + 1}`] = `follow the ${l.kind.replace("_", " ")} link to "${l.title ?? l.path}"`;
  });
  const state = { query, current_page: summary(db, config, path) };
  const questions: Questions = {
    next: {
      type: "choice",
      instructions: "Which step brings you to the specification the query asks for?",
      criteria,
    },
  };
  return { state, questions, links: links.slice(0, 254).map((l) => l.path) };
}
