#!/usr/bin/env bun
/** Draw the blind audit sample for T3: random test items per class, fixed seed, committed before labelling. */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA } from "../lib/paths.ts";
import { shuffle } from "../lib/rng.ts";
import type { T3Item } from "./errata.ts";

const PER_CLASS = 30;
const SEED = 20260928;
const { items } = JSON.parse(readFileSync(join(DATA, "t3-errata.json"), "utf8")) as {
  items: T3Item[];
};
const ids = (["technical", "editorial"] as const).flatMap((l) =>
  shuffle(
    items.filter((i) => i.split === "test" && i.label === l),
    SEED,
  )
    .slice(0, PER_CLASS)
    .map((i) => i.id),
);
// Interleaved by a second shuffle, so the labeller cannot infer the class from position.
writeFileSync(
  join(DATA, "audit", "t3-sample.json"),
  JSON.stringify({ seed: SEED, per_class: PER_CLASS, ids: shuffle(ids, SEED + 1) }, null, 1) + "\n",
);
console.log(ids.length, "items");
