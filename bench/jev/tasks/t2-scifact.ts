/**
 * T2, tier R, external benchmark. Question: given a claim and the abstract it cites, does the
 * abstract support it, contradict it, or say nothing about it? SciFact's expert labels are the
 * ground truth. Pre-registered: committed before any model sees these pairs.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fetchScifact } from "../fetch/scifact.ts";
import type { Questions } from "../lib/questions.ts";

export type Verdict = "supports" | "contradicts" | "says_nothing";

export const QUESTIONS: Questions = {
  verdict: {
    type: "choice",
    instructions: "What does the cited text say about the claim?",
    criteria: {
      supports: "the cited text states or directly implies the claim",
      contradicts: "the cited text states or directly implies that the claim is false",
      says_nothing: "the cited text does not settle whether the claim is true",
    },
  },
};

export const PROTOCOL = {
  // A citation is accepted as supporting only when P(supports) >= tau.
  // tau is the smallest grid value whose false-"supports" rate on calibration is at most this.
  calibration_max_false_support: 0.05,
  tau_grid: Array.from({ length: 99 }, (_, i) => (i + 1) / 100),
  // Calibration comes from SciFact's train split, so dev stays untouched until the one scoring run.
  calibration_pairs: 300,
  calibration_seed: 20260930,
} as const;

export interface Pair {
  id: string;
  split: "calibration" | "test";
  label: Verdict;
  state: { claim: string; cited_title: string; cited_text: string };
}

const MAP: Record<string, Verdict> = { SUPPORT: "supports", CONTRADICT: "contradicts" };

export async function loadPairs(): Promise<Pair[]> {
  const dir = await fetchScifact();
  const corpus = new Map<number, { title: string; abstract: string[] }>();
  for (const line of readFileSync(join(dir, "corpus.jsonl"), "utf8").split("\n").filter(Boolean)) {
    const d = JSON.parse(line);
    corpus.set(d.doc_id, d);
  }
  const pairsOf = (file: string, split: Pair["split"]) =>
    readFileSync(join(dir, file), "utf8")
      .split("\n")
      .filter(Boolean)
      .flatMap((line) => {
        const c = JSON.parse(line);
        return (c.cited_doc_ids as number[]).map((doc) => {
          const ev = c.evidence[String(doc)];
          const d = corpus.get(doc)!;
          return {
            id: `${split}:${c.id}:${doc}`,
            split,
            label: ev ? MAP[ev[0].label]! : "says_nothing",
            state: { claim: c.claim, cited_title: d.title, cited_text: d.abstract.join(" ") },
          } satisfies Pair;
        });
      });
  const { shuffle } = await import("../lib/rng.ts");
  const calibration = shuffle(
    pairsOf("claims_train.jsonl", "calibration"),
    PROTOCOL.calibration_seed,
  ).slice(0, PROTOCOL.calibration_pairs);
  return [...calibration, ...pairsOf("claims_dev.jsonl", "test")];
}
