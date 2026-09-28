#!/usr/bin/env bun
/**
 * Blind audit in the terminal: each sampled item without its label or any model output.
 * Resumable; answers are saved after every item.
 *   bun bench/jev/audit.ts t3 | l3 | t3c | t2a      (or `all`, in that order)
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA } from "./lib/paths.ts";
import { loadCases } from "./tasks/t3-errata.ts";
import { loadItems, stateFor as gotState } from "./tasks/t3-got.ts";
import { loadPairs, stateFor as pairState } from "./tasks/t2-atlas.ts";

const RED = "\x1b[31m",
  GREEN = "\x1b[32m",
  DIM = "\x1b[2m",
  BOLD = "\x1b[1m",
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

interface Task {
  title: string;
  question: string;
  keys: Record<string, string>;
  items: () => Promise<Map<string, string>>;
}

const TASKS: Record<string, Task> = {
  t3: {
    title: "Errata: did the correction change the technical meaning?",
    question: "Would a statement written from the original text now be wrong?",
    keys: { m: "technical", c: "editorial", "?": "unsure" },
    items: async () =>
      new Map(
        (await loadCases()).map((c) => [
          c.id,
          `${DIM}${c.state.rfc} · section ${c.section || "?"}${RESET}\n\n${wordDiff(c.orig, c.corrected)}`,
        ]),
      ),
  },
  l3: {
    title: "Claims about specifications: is the claim still true after the correction?",
    question: "Is the claim now wrong or no longer supported?",
    keys: { i: "invalidated", v: "valid", "?": "unsure" },
    items: async () => {
      const claims = new Map(
        (
          JSON.parse(readFileSync(join(DATA, "t3-claims.json"), "utf8")).items as {
            id: string;
            claim: string;
          }[]
        ).map((c) => [c.id, c.claim]),
      );
      return new Map(
        (await loadCases())
          .filter((c) => claims.has(c.id))
          .map((c) => [
            c.id,
            `${DIM}${c.state.rfc}${RESET}\n\n${BOLD}Claim:${RESET} ${claims.get(c.id)}\n\n${wordDiff(c.orig, c.corrected)}`,
          ]),
      );
    },
  },
  t3c: {
    title: "Claims about got's code: is the claim still true at v14.4.0?",
    question: "Is the claim now wrong or no longer supported?",
    keys: { i: "invalidated", v: "valid", "?": "unsure" },
    items: async () => {
      const { touched, untouched } = loadItems();
      return new Map(
        [...touched, ...untouched].map((t) => {
          const s = gotState(t);
          return [
            t.id,
            `${DIM}${s.file}${RESET}\n\n${BOLD}Claim:${RESET} ${s.claim}\n\n${wordDiff(s.original, s.corrected)}`,
          ];
        }),
      );
    },
  },
  t2a: {
    title: "Citations: what do the cited lines say about the claim?",
    question: "Do the cited lines support the claim?",
    keys: { s: "supports", x: "contradicts", n: "says_nothing", "?": "unsure" },
    items: async () =>
      new Map(
        loadPairs().map((p) => {
          const s = pairState(p, "C1");
          return [
            p.id,
            `${BOLD}Claim:${RESET} ${s.claim}\n\n${DIM}Cited text:${RESET}\n${s.cited_text}`,
          ];
        }),
      ),
  },
};

const requested = process.argv[2] === "all" ? Object.keys(TASKS) : [process.argv[2] ?? ""];
if (!requested.every((t) => t in TASKS))
  throw new Error("usage: bun bench/jev/audit.ts t3|l3|t3c|t2a|all");

outer: for (const name of requested) {
  const task = TASKS[name]!;
  const out = join(DATA, "audit", `${name}-maintainer.json`);
  const answers: Record<string, string> = existsSync(out)
    ? JSON.parse(readFileSync(out, "utf8")).answers
    : {};
  const { ids } = JSON.parse(readFileSync(join(DATA, "audit", `${name}-sample.json`), "utf8")) as {
    ids: string[];
  };
  const items = await task.items();
  const legend = Object.entries(task.keys)
    .map(([k, v]) => `${k} = ${v}`)
    .join(" · ");
  let n = 0;
  for (const id of ids) {
    n++;
    if (answers[id]) continue;
    console.clear();
    console.log(`${BOLD}${task.title}${RESET}  ${DIM}${n}/${ids.length}${RESET}\n`);
    console.log(items.get(id) ?? `(missing item ${id})`);
    console.log(`\n${task.question}`);
    const prompt = `  ${legend} · q = quit > `;
    process.stdout.write(prompt);
    let key = "";
    for await (const line of console) {
      key = line.trim();
      if (key === "q" || key in task.keys) break;
      process.stdout.write(prompt);
    }
    if (key === "q") break outer;
    answers[id] = task.keys[key]!;
    writeFileSync(
      out,
      JSON.stringify({ labeller: "maintainer", blind: true, answers }, null, 1) + "\n",
    );
  }
  console.log(`\n${name}: ${Object.keys(answers).length}/${ids.length} labelled → ${out}`);
}
process.exit(0);
