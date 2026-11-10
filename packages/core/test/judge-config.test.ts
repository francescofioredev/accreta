import { describe, expect, test } from "bun:test";
import { parseConfig } from "../src/config.ts";
import { JUDGE_DEFAULTS, resolveJudgeSettings } from "../src/judge.ts";

describe("the judge block", () => {
  test("a config without one has no judge key at all", () => {
    expect("judge" in parseConfig("page_types: [note]")).toBe(false);
    expect(resolveJudgeSettings(parseConfig("").judge, {})).toBeNull();
  });

  test("the study's values are the defaults", () => {
    const settings = resolveJudgeSettings(parseConfig("judge:\n  route: local\n").judge, {});
    expect(settings).toMatchObject({
      apiKeyEnv: "ACCRETA_JUDGE_KEY",
      rerankTop: 20,
      supportThreshold: 0.73,
      problems: [],
    });
    expect(JUDGE_DEFAULTS.supportThreshold).toBe(0.73);
  });

  test("ACCRETA_JUDGE_* override the file", () => {
    const block = parseConfig(
      "judge:\n  route: local\n  rerank: { top: 10 }\n  support: { threshold: 0.9 }\n",
    ).judge;
    const settings = resolveJudgeSettings(block, {
      ACCRETA_JUDGE_ROUTE: "typesafe",
      ACCRETA_JUDGE_RERANK_TOP: "5",
      ACCRETA_JUDGE_SUPPORT_THRESHOLD: "0.8",
      ACCRETA_JUDGE_API_KEY_ENV: "ACCRETA_OTHER",
    });
    expect(settings).toMatchObject({
      route: "typesafe",
      rerankTop: 5,
      supportThreshold: 0.8,
      apiKeyEnv: "ACCRETA_OTHER",
    });
  });

  test("unusable values are named, and the default holds", () => {
    const block = parseConfig(
      "judge:\n  route: local\n  rerank: { top: 500 }\n  support: { threshold: 2 }\n",
    ).judge;
    const settings = resolveJudgeSettings(block, { ACCRETA_JUDGE_RERANK_TOP: "many" });
    expect(settings?.rerankTop).toBe(20);
    expect(settings?.supportThreshold).toBe(0.73);
    expect(settings?.problems).toEqual([
      "judge.rerank.top is not usable",
      "judge.support.threshold is not usable",
      "ACCRETA_JUDGE_RERANK_TOP is not usable (a whole number from 1 to 50)",
    ]);
  });

  test("a key pasted into the block is kept as an unknown key for doctor", () => {
    const block = parseConfig(
      "judge:\n  route: local\n  api_key: abc\n  support: { token: x }\n",
    ).judge;
    expect(block?.unknownKeys).toEqual(["support.token", "api_key"]);
  });

  test("an empty block has no route", () => {
    const settings = resolveJudgeSettings(parseConfig("judge:\n").judge, {});
    expect(settings?.problems).toEqual(["judge.route is not set"]);
  });
});

describe("judge block shape", () => {
  test("a scalar block says so", () => {
    expect(resolveJudgeSettings(parseConfig("judge: 3").judge, {})?.problems).toContain(
      "judge is not a mapping",
    );
  });
});
