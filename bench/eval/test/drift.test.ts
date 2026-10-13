import { describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { measureDrift } from "../drift-score.ts";
import { kbAt } from "../lib/accreta.ts";
import { scoreDrift, type DriftJson } from "../lib/drift-match.ts";
import { judgeBlock, occurrences, type CitationTruth } from "../lib/drift-truth.ts";
import { git } from "../lib/git.ts";
import { commit, declareGit, kbDir, lines, page, repo, write } from "./fixture.ts";

describe("judgeBlock", () => {
  const before = lines(6);
  test("same place is untouched, elsewhere once is moved, gone is changed", () => {
    expect(judgeBlock(before, [2, 3], "a", { path: "a", text: before })).toMatchObject({
      status: "untouched",
    });
    expect(judgeBlock(before, [2, 3], "a", { path: "b", text: before })).toMatchObject({
      status: "moved",
      now: { path: "b", locator: "L2-L3" },
    });
    expect(judgeBlock(before, [2, 3], "a", { path: "a", text: `new\n${before}` })).toMatchObject({
      status: "moved",
      now: { locator: "L3-L4" },
    });
    expect(
      judgeBlock(before, [2, 3], "a", { path: "a", text: lines(6, { 3: "x" }) }),
    ).toMatchObject({ status: "changed" });
    expect(judgeBlock(before, [2, 3], "a", null)).toMatchObject({ status: "changed" });
  });

  test("a block found twice elsewhere is ambiguous; a range past the end is out", () => {
    const twice = `x\n${before}${before}`;
    expect(judgeBlock(before, [2, 3], "a", { path: "a", text: twice }).excluded).toMatch(
      /ambiguous/,
    );
    expect(judgeBlock(before, [5, 9], "a", { path: "a", text: before }).excluded).toBe(
      "range outside the file",
    );
    expect(occurrences(["a", "b", "a", "b"], ["a", "b"])).toEqual([1, 3]);
  });

  test("a block with a twin at its own revision is ambiguous, edited or not", () => {
    const twin = "a\nb\nc\na\nb\n";
    expect(judgeBlock(twin, [1, 2], "f", { path: "f", text: "x\nb\nc\na\nb\n" })).toEqual({
      status: null,
      excluded: "ambiguous at its revision",
    });
    // A single edited line whose twin survives would otherwise read as moved.
    const lone = "foo\nbar\nfoo\n";
    expect(judgeBlock(lone, [1, 1], "f", { path: "f", text: "baz\nbar\nfoo\n" }).excluded).toBe(
      "ambiguous at its revision",
    );
  });
});

describe("scoreDrift", () => {
  const t = (
    page: string,
    footnote: string,
    status: CitationTruth["status"],
    path = "a.py",
  ): CitationTruth => ({
    page,
    footnote,
    source: "app",
    path,
    locator: "L1",
    revision: "r",
    status,
    excluded: null,
  });
  const json = (flagged: [string, string][], repin: [string, string][] = []): DriftJson => ({
    sources: [
      {
        source_id: "app",
        in_doubt: flagged.map(([page, footnote]) => ({
          page,
          citations: [{ footnote, path: "a.py", locator: "L1", change: "touched" }],
        })),
        repin: repin.map(([page, footnote]) => ({
          page,
          citations: [{ footnote, path: "a.py", locator: "L1" }],
        })),
        unresolvable: [],
      },
    ],
  });

  test("a missed change is a false negative, counted per citation and per page", () => {
    const truth = [t("p", "a", "changed"), t("p", "b", "changed"), t("q", "c", "untouched")];
    const s = scoreDrift(truth, json([["p", "a"]]));
    expect(s.perCitation).toMatchObject({ tp: 1, fp: 0, fn: 1, tn: 1 });
    expect(s.perCitation.recall.rate).toBe(0.5);
    expect(s.perPageAnyHit).toMatchObject({ tp: 1, fp: 0, fn: 0, tn: 1 });
  });

  test("the H2 gate needs few exclusions and positives spread over 20 files", () => {
    const hits = (files: number) =>
      Array.from({ length: 36 }, (_, i) => t(`p${i}`, "a", "changed", `f${i % files}.py`));
    const flagAll = (truth: CitationTruth[]): DriftJson => ({
      sources: [
        {
          source_id: "app",
          in_doubt: truth.map((c) => ({
            page: c.page,
            citations: [{ footnote: "a", path: c.path, locator: "L1", change: "touched" }],
          })),
          repin: [],
          unresolvable: [],
        },
      ],
    });
    expect(scoreDrift(hits(36), flagAll(hits(36))).h2).toEqual({ verdict: "met", reasons: [] });
    const clustered = scoreDrift(hits(5), flagAll(hits(5)));
    expect(clustered.perCitation.gate).toBe("met");
    expect(clustered.h2.verdict).toBe("not shown");
    expect(clustered.positiveFiles).toBe(5);
    const out = { ...t("x", "z", null), excluded: "unpinned" as const };
    const excluded = scoreDrift([...hits(36), ...Array(10).fill(out)], flagAll(hits(36)));
    expect(excluded.h2.reasons[0]).toMatch(/10 of 46 citations excluded/);
    expect(excluded.recallExclusionsAsMisses).toMatchObject({ k: 36, n: 46 });
  });

  test("a moved block drift asks to re-pin is a true negative", () => {
    const s = scoreDrift([t("p", "a", "moved")], json([], [["p", "a"]]));
    expect(s.perCitation).toMatchObject({ tp: 0, fp: 0, fn: 0, tn: 1 });
    expect(s.moved).toEqual({ total: 1, repin: 1, flagged: 0, quiet: 0 });
    expect(s.defects).toEqual([]);
  });

  test("a moved block drift says nothing about is a defect; a one-line move is listed for audit", () => {
    const one = { ...t("p", "a", "moved"), now: { path: "a.py", locator: "L5" } };
    const s = scoreDrift([one], json([]));
    expect(s.defects[0]).toMatch(/1 moved citation/);
    expect(s.auditSingleLineMoved.map((c) => c.footnote)).toEqual(["a"]);
  });

  test("a page drift could only judge per file flags its citations into the changed files", () => {
    const perFile: DriftJson = {
      sources: [
        {
          source_id: "app",
          in_doubt: [{ page: "p", citations: null, changed_paths: ["a.py"] }],
          repin: [],
          unresolvable: [],
        },
      ],
    };
    expect(scoreDrift([t("p", "a", "untouched")], perFile).perCitation.fp).toBe(1);
  });
});

test("the real drift on an edit, an untouched citation, a rename, a shift and a cross-source footnote", () => {
  const root = kbDir();
  const src = join(root, "sources", "repo");
  const pin = repo(src, {
    "app/src/app.py": lines(30),
    "app/src/old.py": lines(20),
    "app/src/util.py": lines(20),
    "lib/README.md": lines(10),
  });
  declareGit(root, "app", "sources/repo/app");
  declareGit(root, "lib", "sources/repo/lib");
  const at = pin.slice(0, 7);
  const cite = (id: string, source: string, path: string) =>
    `[^${id}]: ${source} @ ${at} · ${path}`;
  const claim = (id: string) => `The module behaves as this sentence says it does.[^${id}]`;
  const body = (ids: [string, string, string][]) =>
    [...ids.map(([id]) => claim(id)), "", ...ids.map(([id, s, p]) => cite(id, s, p))].join("\n\n");
  page(root, "routing", {
    source: "app",
    verified: pin,
    body: body([
      ["edit", "app", "src/app.py#L2-L4"],
      ["renamed", "app", "src/old.py#L5-L7"],
      ["vague", "app", "src/app.py#intro"],
    ]),
  });
  page(root, "helpers", {
    source: "app",
    verified: pin,
    body: body([
      ["shift", "app", "src/util.py#L10-L12"],
      ["lib", "lib", "README.md#L1-L2"],
    ]),
  });
  page(root, "stable", {
    source: "app",
    verified: pin,
    body: body([["same", "app", "src/app.py#L20-L22"]]),
  });

  write(src, "app/src/app.py", lines(30, { 3: "edited 3" }));
  git(src, "mv", "app/src/old.py", "app/src/new.py");
  write(src, "app/src/util.py", `inserted a\ninserted b\n${lines(20)}`);
  write(src, "lib/README.md", lines(10, { 1: "edited 1" }));
  const head = commit(src, "move the pin");

  try {
    const s = measureDrift(kbAt(root), head);
    const by = Object.fromEntries(s.citations.map((c) => [c.footnote, c]));
    expect(by.edit).toMatchObject({ status: "changed", prediction: "flagged" });
    expect(by.same).toMatchObject({ status: "untouched", prediction: "quiet" });
    // drift reads a renamed file as deleted: an unchanged block there is a false positive.
    expect(by.renamed).toMatchObject({
      status: "moved",
      now: { path: "src/new.py", locator: "L5-L7" },
      prediction: "flagged",
    });
    expect(by.shift).toMatchObject({
      status: "moved",
      now: { locator: "L12-L14" },
      prediction: "repin",
    });
    expect(by.lib).toMatchObject({ source: "lib", status: "changed", prediction: "flagged" });
    expect(by.vague).toBeUndefined();
    expect(s.excluded).toEqual({ "not a line range": 1 });
    expect(s.excludedShare).toMatchObject({ k: 1, n: 6 });

    expect(s.perCitation).toMatchObject({ tp: 2, fp: 1, fn: 0, tn: 2 });
    expect(s.perCitation.recall).toMatchObject({ k: 2, n: 2, rate: 1 });
    expect(s.perCitation.gate).toBe("not shown");
    expect(s.perPageAnyHit).toMatchObject({ tp: 2, fp: 0, fn: 0, tn: 1 });
    expect(s.moved).toEqual({ total: 2, repin: 1, flagged: 1, quiet: 0 });
    // Every scored citation's file changed, so the trivial baseline flags all five.
    expect(s.baselineFileChanged).toMatchObject({ tp: 2, fp: 3, fn: 0, tn: 0 });
    expect(s.positiveFiles).toBe(2);
    expect(s.h2.verdict).toBe("not shown");
    expect(s.recallExclusionsAsMisses).toMatchObject({ k: 2, n: 3 });
    expect(() => measureDrift(kbAt(root), pin)).toThrow(/check it out first/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
