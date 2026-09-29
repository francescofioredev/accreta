#!/usr/bin/env bun
/**
 * T4, tier R: queries over the RFC knowledge base, three classes, gold from the RFC index.
 *   title        the RFC's own title (control: lexical search should find it)
 *   paraphrase   a question written from the abstract, avoiding the title's words
 *   supersession "what replaces <old title>?": the answer is reached only by following obsoleted-by
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA } from "../lib/paths.ts";
import { pool } from "../lib/pool.ts";
import { rfcIndex, type RfcEntry } from "../lib/rfc-index.ts";
import { shuffle } from "../lib/rng.ts";
import { writeText } from "../lib/writer.ts";

export const PER_CLASS = 150;
const SEED = 20261003;
export const WRITER = "claude-sonnet-5";
const SYSTEM =
  "You write one question a developer might type into a search box of a documentation site, whose answer is the " +
  "specification described. Ask about what the specification lets you do or defines, in plain words. Do not use " +
  "the specification's title, its acronyms or its distinctive terms; do not mention RFC numbers. Reply only with the JSON the schema requires.";

const path = (id: string) => `knowledge/rfc/rfc${Number(id.replace("RFC", ""))}.md`;

/** Follow obsoleted-by to the specifications nothing obsoletes. */
function current(id: string, index: Map<string, RfcEntry>, seen = new Set<string>()): string[] {
  const e = index.get(id);
  if (!e || seen.has(id)) return [];
  seen.add(id);
  const next = e.obsoletedBy.filter((x) => index.has(x));
  return next.length ? [...new Set(next.flatMap((n) => current(n, index, seen)))] : [id];
}

if (import.meta.main) {
  const index = rfcIndex();
  const all = [...index.values()];
  const withAbstract = all.filter((e) => e.abstract.length >= 200 && Number(e.id.slice(3)) >= 1500);
  const titles = shuffle(withAbstract, SEED).slice(0, PER_CLASS);
  const paraphrase = shuffle(
    withAbstract.filter((e) => !titles.includes(e)),
    SEED + 1,
  ).slice(0, PER_CLASS);
  const obsoleted = shuffle(
    all.filter((e) => e.obsoletedBy.some((x) => index.has(x)) && e.title.length > 10),
    SEED + 2,
  ).slice(0, PER_CLASS);

  const written = await pool(
    paraphrase,
    8,
    (e) =>
      writeText(
        "t4-paraphrase",
        WRITER,
        SYSTEM,
        `Specification abstract:\n${e.abstract}`,
        "question",
      ),
    "paraphrase",
  );
  // Paraphrases are judged against the RFC and its supersession neighbours, which describe the same thing.
  const lineage = (e: RfcEntry) =>
    [e.id, ...e.obsoletes, ...e.obsoletedBy].filter((x) => index.has(x)).map(path);
  const queries = [
    ...titles.map((e) => ({
      id: `title:${e.id}`,
      class: "title",
      query: e.title,
      relevant: [path(e.id)],
      start: null,
    })),
    ...paraphrase.map((e, i) => ({
      id: `paraphrase:${e.id}`,
      class: "paraphrase",
      query: written[i]!.text,
      relevant: lineage(e),
      start: null,
      ...(written[i]!.error ? { error: written[i]!.error } : {}),
    })),
    ...obsoleted.map((e) => ({
      id: `supersession:${e.id}`,
      class: "supersession",
      query: `What is the current specification that replaces "${e.title}"?`,
      relevant: current(e.id, index).map(path),
      start: path(e.id),
    })),
  ];
  writeFileSync(
    join(DATA, "t4-queries.json"),
    JSON.stringify(
      { seed: SEED, per_class: PER_CLASS, writer: WRITER, system: SYSTEM, queries },
      null,
      1,
    ) + "\n",
  );
  const hops = obsoleted.map((e) => {
    let n = 0;
    let cur = [e.id];
    while (cur.some((c) => index.get(c)?.obsoletedBy.length)) {
      cur = cur.flatMap((c) => index.get(c)!.obsoletedBy.filter((x) => index.has(x)));
      n++;
      if (n > 10) break;
    }
    return n;
  });
  console.log(
    queries.length,
    "queries;",
    queries.filter((q) => !q.query).length,
    "missing; supersession hops:",
    Object.fromEntries(
      [1, 2, 3, 4].map((h) => [h, hops.filter((x) => (h === 4 ? x >= 4 : x === h)).length]),
    ),
    "; $",
    written.reduce((s, w) => s + w.cost_usd, 0).toFixed(2),
  );
}
