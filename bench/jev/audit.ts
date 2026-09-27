#!/usr/bin/env bun
/**
 * Blind audit in the terminal: shows each sampled item without its label or any model output,
 * and records the maintainer's judgement. Resumable; answers are saved after every item.
 *   bun bench/jev/audit.ts t3
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA } from "./lib/paths.ts";
import { loadCases } from "./tasks/t3-errata.ts";

const task = process.argv[2];
if (task !== "t3") throw new Error("usage: bun bench/jev/audit.ts t3");

const out = join(DATA, "audit", "t3-maintainer.json");
const answers: Record<string, string> = existsSync(out)
  ? JSON.parse(readFileSync(out, "utf8")).answers
  : {};
const { ids } = JSON.parse(readFileSync(join(DATA, "audit", "t3-sample.json"), "utf8")) as {
  ids: string[];
};
const cases = new Map((await loadCases()).map((c) => [c.id, c]));

const RED = "\x1b[31m",
  GREEN = "\x1b[32m",
  DIM = "\x1b[2m",
  RESET = "\x1b[0m";
function wordDiff(a: string, b: string): string {
  const x = a.split(/(\s+)/),
    y = b.split(/(\s+)/);
  const dp = Array.from({ length: x.length + 1 }, () => new Array<number>(y.length + 1).fill(0));
  for (let i = x.length - 1; i >= 0; i--)
    for (let j = y.length - 1; j >= 0; j--)
      dp[i]![j] = x[i] === y[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
  let i = 0,
    j = 0,
    s = "";
  while (i < x.length || j < y.length) {
    if (i < x.length && j < y.length && x[i] === y[j]) {
      s += x[i++];
      j++;
    } else if (j < y.length && (i === x.length || dp[i]![j + 1]! >= dp[i + 1]![j]!))
      s += `${GREEN}[+${y[j++]}]${RESET}`;
    else s += `${RED}[-${x[i++]}]${RESET}`;
  }
  return s;
}

const prompt = "  m = meaning changed · c = cosmetic only · ? = cannot tell · q = quit > ";
let n = 0;
for (const id of ids) {
  n++;
  if (answers[id]) continue;
  const c = cases.get(id)!;
  console.clear();
  console.log(`${DIM}${n}/${ids.length} · ${c.state.rfc} · section ${c.section || "?"}${RESET}\n`);
  console.log(wordDiff(c.orig, c.corrected));
  console.log(`\nWould a statement written from the original text now be wrong?`);
  process.stdout.write(prompt);
  let key = "";
  for await (const line of console) {
    key = line.trim();
    if (["m", "c", "?", "q"].includes(key)) break;
    process.stdout.write(prompt);
  }
  if (key === "q") break;
  answers[id] = key === "m" ? "technical" : key === "c" ? "editorial" : "unsure";
  writeFileSync(
    out,
    JSON.stringify({ labeller: "maintainer", blind: true, answers }, null, 1) + "\n",
  );
}
console.log(`\n${Object.keys(answers).length}/${ids.length} labelled → ${out}`);
process.exit(0);
