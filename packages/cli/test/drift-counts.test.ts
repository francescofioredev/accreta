import { describe, expect, test } from "bun:test";
import type { CitedChange, DriftReport, StaleRevision } from "@accreta/core";
import { printReports, printText, toGithub, toJson } from "../src/commands/drift.ts";

const PAGE = "knowledge/contradiction.md";

function touched(revision: string, footnote: string): CitedChange {
  return {
    page: PAGE,
    footnote,
    path: "note.md",
    locator: "L5-L7",
    revision,
    change: { status: "touched" },
  };
}

function stale(revision: string, footnote: string, citedOnly: boolean): StaleRevision {
  return {
    revision,
    changedPaths: ["note.md"],
    pages: [PAGE],
    ...(citedOnly ? { citedOnly: [PAGE] } : {}),
    citations: [touched(revision, footnote)],
  };
}

function report(sourceId: string, entries: StaleRevision[]): DriftReport {
  return {
    sourceId,
    currentRevision: "now",
    stale: entries,
    unverifiable: [],
    unresolvable: [],
    delegated: null,
  };
}

function text(r: DriftReport): string {
  const lines: string[] = [];
  printText({ out: (line: string) => lines.push(line) }, r);
  return lines.join("\n");
}

describe("drift counts each page once", () => {
  test("a page in doubt under its own source and under one it cites", () => {
    const reports = [
      report("ipcc", [stale("a1", "a", false)]),
      report("noaa", [stale("b1", "b", true)]),
    ];
    const json = toJson(reports, new Set());
    expect(json.pages_in_doubt).toBe(1);
    expect(json.pages_newly_in_doubt).toBe(1);
    expect(toGithub(reports)).toContain("**1 page in doubt:**");
    const lines: string[] = [];
    printReports({ out: (line: string) => lines.push(line) }, reports);
    expect(lines.filter((line) => line === "  1 page(s) in doubt:")).toHaveLength(2);
    expect(lines.at(-1)).toBe("1 page(s) in doubt across 2 sources");
  });

  test("one source prints no total", () => {
    const lines: string[] = [];
    printReports({ out: (line: string) => lines.push(line) }, [
      report("ipcc", [stale("a1", "a", false)]),
    ]);
    expect(lines.join("\n")).not.toContain("across");
  });

  test("no total when nothing is in doubt, so a failing run does not end on all clear", () => {
    const moved: StaleRevision = {
      ...stale("a1", "a", false),
      citations: [{ ...touched("a1", "a"), change: { status: "moved", locator: "L6-L8" } }],
    };
    const lines: string[] = [];
    printReports({ out: (line: string) => lines.push(line) }, [
      report("ipcc", [moved]),
      report("noaa", []),
    ]);
    expect(lines.join("\n")).toContain("no page in doubt; 1 to re-pin or re-verify");
    expect(lines.join("\n")).not.toContain("across");
  });

  test("a page with footnotes pinned at two stale revisions", () => {
    const noaa = report("noaa", [stale("b0", "old", true), stale("b1", "new", true)]);
    expect(toJson([noaa]).pages_in_doubt).toBe(1);
    expect(text(noaa)).toContain("1 page(s) in doubt");
  });

  test("a page pinned at revisions in doubt, moved and untouched counts only as in doubt", () => {
    const at = (revision: string, change: CitedChange["change"]): StaleRevision => ({
      ...stale(revision, revision, true),
      citations: [{ ...touched(revision, revision), change }],
    });
    const noaa = report("noaa", [
      at("b0", { status: "untouched" }),
      at("b1", { status: "moved", locator: "L6-L8" }),
      at("b2", { status: "touched" }),
    ]);
    expect(toJson([noaa]).pages_in_doubt).toBe(1);
    const out = text(noaa);
    expect(out).toContain("  1 page(s) in doubt:");
    expect(out).not.toContain("to re-pin");
    expect(out).not.toContain("behind the source");
    // Every revision's detail stays, under the one group.
    expect(out).toContain(`${PAGE} (cited at b0) — cited lines unchanged`);
    expect(out).toContain(`${PAGE} (cited at b1) — re-pin note.md#L5-L7 → L6-L8`);
    expect(out).toContain(`${PAGE} (cited at b2) — 1 cited range(s) changed`);
  });

  test("a page no source can place, twice", () => {
    const unplaced = (id: string, revision: string): DriftReport => ({
      ...report(id, []),
      unresolvable: [{ revision, pages: [PAGE] }],
    });
    const json = toJson([unplaced("ipcc", "a0"), unplaced("noaa", "b0")], new Set());
    expect(json.pages_unplaceable).toBe(1);
    expect(json.pages_newly_unplaceable).toBe(1);
  });

  test("a page under two revisions one source cannot place", () => {
    const noaa: DriftReport = {
      ...report("noaa", []),
      unresolvable: [
        { revision: "b0", pages: [PAGE], citedOnly: [PAGE] },
        { revision: "b1", pages: [PAGE], citedOnly: [PAGE] },
      ],
    };
    expect(toJson([noaa]).pages_unplaceable).toBe(1);
    expect(text(noaa)).toContain("1 page(s) rest on 2 revision(s) this source cannot place:");
  });
});

describe("a page citing the source without a revision", () => {
  const withUnpinned: DriftReport = {
    ...report("noaa", []),
    unverifiable: ["knowledge/loose.md", PAGE],
    unpinned: [
      { page: PAGE, footnote: "b" },
      { page: PAGE, footnote: null },
    ],
  };

  test("is named apart from pages that record no revision", () => {
    const out = text(withUnpinned);
    expect(out).toContain("1 page(s) record no revision at all");
    expect(out).toContain("1 page(s) cite this source without a revision:");
    expect(out).toContain(`${PAGE} [^b] names no revision: pin it to a revision`);
    expect(out).toContain(
      `${PAGE} canonical_source names no revision: add a pinned footnote to the same place`,
    );
  });

  test("and in the pull request comment", () => {
    const out = toGithub([withUnpinned]);
    expect(out).toContain("1 page(s) record no revision at all.");
    expect(out).toContain("1 page(s) cite this source without a revision:");
    expect(out).toContain(`- \`${PAGE}\` \`[^b]\` names no revision: pin it to a revision.`);
  });
});

describe("a page that only cites the source", () => {
  test("is labelled cited at, not verified at", () => {
    const noaa = report("noaa", [stale("b1", "b", true)]);
    expect(text(noaa)).toContain(`${PAGE} (cited at b1)`);
    const page = toJson([noaa]).sources[0]!.in_doubt[0]!;
    expect(page.cited_at).toBe("b1");
    expect(page.verified_at).toBeUndefined();
  });

  test("is labelled cited at under a revision the source cannot place", () => {
    const noaa: DriftReport = {
      ...report("noaa", []),
      unresolvable: [{ revision: "b0", pages: ["knowledge/own.md", PAGE], citedOnly: [PAGE] }],
    };
    const out = text(noaa);
    expect(out).toContain("2 page(s) rest on 1 revision(s) this source cannot place:\n    b0:");
    expect(out).toContain("knowledge/own.md (verified)");
    expect(out).toContain(`${PAGE} (cited)`);
  });

  test("a per-file source names only the changed files it cites", () => {
    const noaa = report("noaa", [
      {
        revision: "b1",
        changedPaths: ["a.md", "b.md", "c.md", "d.md", "e.md", "note.md"],
        pages: [PAGE],
        citedOnly: [PAGE],
        citedPaths: { [PAGE]: ["note.md"] },
      },
    ]);
    const row = toGithub([noaa])
      .split("\n")
      .find((line) => line.startsWith(`| \`${PAGE}\``));
    expect(row).toBe(
      `| \`${PAGE}\` | \`note.md\` | \`b1\` | file changed; this source cannot tell lines |`,
    );
  });
});
