#!/usr/bin/env bun
/** Blind audit samples for L3, tier C drift and tier A citation support. Fixed seeds, committed before labelling. */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA } from "../lib/paths.ts";
import { shuffle } from "../lib/rng.ts";
import { loadPairs } from "../tasks/t2-atlas.ts";
import { loadItems } from "../tasks/t3-got.ts";

const SEED = 20261007;
const claims = (
  JSON.parse(readFileSync(join(DATA, "t3-claims.json"), "utf8")).items as {
    id: string;
    label: string;
    claim: string;
  }[]
).filter((c) => c.claim);
const l3 = shuffle(
  ["technical", "editorial"].flatMap((l) =>
    shuffle(
      claims.filter((c) => c.label === l),
      SEED,
    )
      .slice(0, 10)
      .map((c) => c.id),
  ),
  SEED + 1,
);
const { touched, untouched } = loadItems();
const t3c = shuffle(
  [...shuffle(touched, SEED).slice(0, 20), ...shuffle(untouched, SEED).slice(0, 10)].map(
    (i) => i.id,
  ),
  SEED + 2,
);
const pairs = loadPairs();
const t2a = shuffle(
  [
    ...shuffle(
      pairs.filter((p) => p.kind === "real"),
      SEED,
    ).slice(0, 15),
    ...shuffle(
      pairs.filter((p) => p.kind === "negative"),
      SEED,
    ).slice(0, 15),
  ].map((p) => p.id),
  SEED + 3,
);
for (const [name, ids] of [
  ["l3", l3],
  ["t3c", t3c],
  ["t2a", t2a],
] as const) {
  writeFileSync(
    join(DATA, "audit", `${name}-sample.json`),
    JSON.stringify({ seed: SEED, ids }, null, 1) + "\n",
  );
  console.log(name, ids.length);
}
