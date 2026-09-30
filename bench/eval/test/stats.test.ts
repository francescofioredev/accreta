import { describe, expect, test } from "bun:test";
import {
  clopperPearson,
  gate,
  mcnemarExact,
  mcnemarPaired,
  mcnemarThreshold,
  positivesNeeded,
  rate,
  summary,
  wilson,
} from "../lib/stats.ts";

const close = (a: number, b: number, digits = 4) => expect(a).toBeCloseTo(b, digits);

describe("intervals", () => {
  test("Wilson matches published values", () => {
    const [lo0, hi0] = wilson(0, 10);
    close(lo0, 0);
    close(hi0, 0.2775);
    const [lo5, hi5] = wilson(5, 10);
    close(lo5, 0.2366);
    close(hi5, 0.7634);
  });

  test("Clopper–Pearson for one error in twenty, as model-routing.md quotes it", () => {
    const [lo, hi] = clopperPearson(1, 20);
    close(lo, 0.00127);
    close(hi, 0.2487);
  });
});

describe("exact McNemar", () => {
  test("six discordant pairs all one way is the smallest significant result", () => {
    close(mcnemarExact(6, 0).pTwoSided, 0.03125, 6);
    close(mcnemarExact(5, 0).pTwoSided, 0.0625, 6);
    close(mcnemarExact(9, 1).pTwoSided, 22 / 1024, 6);
    expect(mcnemarThreshold(5)).toBeNull();
    expect(mcnemarThreshold(6)).toBe(6);
    expect(mcnemarThreshold(10)).toBe(9);
  });

  test("one-sided p counts only the pre-registered direction", () => {
    close(mcnemarExact(6, 0).pAGreater, 1 / 64, 6);
    close(mcnemarExact(0, 6).pAGreater, 1, 6);
    expect(mcnemarExact(0, 0).pTwoSided).toBe(1);
  });

  test("concordant pairs do not move it", () => {
    const a = [true, true, false, true, false];
    const b = [true, false, false, false, false];
    expect(mcnemarPaired(a, b)).toMatchObject({ b: 2, c: 0 });
    expect(() => mcnemarPaired([true], [])).toThrow(/same items/);
  });
});

describe("power limits", () => {
  test("recall 0.9 at zero misses needs 36 positives for a 95% lower bound at 0.9", () => {
    expect(positivesNeeded(0.9, 0)).toBe(36);
    expect(clopperPearson(35, 35)[0]).toBeLessThan(0.9);
    expect(positivesNeeded(0.9, 1)).toBeGreaterThan(36);
  });
});

describe("gate verdicts", () => {
  test("met, not shown, failed, no data", () => {
    expect(gate(rate(36, 36), 0.9)).toBe("met");
    expect(gate(rate(20, 20), 0.9)).toBe("not shown");
    expect(gate(rate(17, 20), 0.9)).toBe("failed");
    expect(gate(rate(0, 0), 0.9)).toBe("no data");
  });

  test("summary", () => {
    expect(summary([3, 1, 2, 10])).toEqual({ n: 4, mean: 4, median: 2.5, max: 10 });
    expect(summary([]).n).toBe(0);
  });
});
