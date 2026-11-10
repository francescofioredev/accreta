import { expect, test } from "bun:test";
import {
  JudgeUnavailableError,
  rerank,
  summaryOf,
  SUMMARY_CHARS,
  type Judge,
  type JudgeCandidate,
} from "../src/index.ts";

const hit = (name: string) => ({ path: `knowledge/${name}.md`, title: name });
const hits = ["a", "b", "c", "d", "e"].map(hit);

function judgeGiving(probabilities: Record<string, number>, seen: JudgeCandidate[][] = []): Judge {
  return {
    async rank(_query, candidates) {
      seen.push([...candidates]);
      return candidates.map((c) => ({
        id: c.id,
        judge: "fake",
        model: "m1",
        probability: probabilities[c.title] ?? 0,
      }));
    },
    supports: () => Promise.reject(new Error("not used")),
  };
}
const summary = (h: { title: string }) => `about ${h.title}`;

test("the top hits come back highest probability first, the rest after them unchanged", async () => {
  const seen: JudgeCandidate[][] = [];
  const out = await rerank(hits, "q", judgeGiving({ a: 0.1, b: 0.8, c: 0.4 }, seen), {
    top: 3,
    summary,
  });
  expect(out.map((h) => h.title)).toEqual(["b", "c", "a", "d", "e"]);
  expect(seen[0]!.map((c) => c.id)).toEqual(hits.slice(0, 3).map((h) => h.path));
  expect(seen[0]![0]).toEqual({ id: "knowledge/a.md", title: "a", summary: "about a" });
});

test("judged hits carry judge, model and probability; the rest carry none", async () => {
  const out = await rerank(hits, "q", judgeGiving({ a: 0.5 }), { top: 2, summary });
  expect(out[0]).toMatchObject({ judge: "fake", model: "m1", probability: 0.5 });
  expect(out[4]).not.toHaveProperty("probability");
});

test("equal probabilities keep the search order", async () => {
  const out = await rerank(hits, "q", judgeGiving({}), { top: 5, summary });
  expect(out.map((h) => h.title)).toEqual(["a", "b", "c", "d", "e"]);
});

test("top defaults to 20 and never exceeds the hits", async () => {
  const seen: JudgeCandidate[][] = [];
  await rerank(hits, "q", judgeGiving({}, seen), { summary });
  expect(seen[0]).toHaveLength(5);
});

test("no hits means no call", async () => {
  const seen: JudgeCandidate[][] = [];
  expect(await rerank([], "q", judgeGiving({}, seen), { summary })).toEqual([]);
  expect(seen).toHaveLength(0);
});

test("a judge that answers for other candidates is unavailable, not trusted", async () => {
  const judge: Judge = {
    rank: async () => [{ id: "elsewhere", judge: "fake", model: "m1", probability: 1 }],
    supports: () => Promise.reject(new Error("not used")),
  };
  const call = rerank([hit("a")], "q", judge, { summary });
  await expect(call).rejects.toBeInstanceOf(JudgeUnavailableError);
});

test("the summary drops the first heading, collapses whitespace and is cut", () => {
  expect(summaryOf("# Title\n\nOne   two\nthree")).toBe("One two three");
  expect(summaryOf("x".repeat(SUMMARY_CHARS + 50))).toHaveLength(SUMMARY_CHARS);
});
