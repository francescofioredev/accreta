import { describe, expect, test } from "bun:test";
import type { CitedChange, DriftReport, StaleRevision } from "@accreta/core";
import { printText, toGithub, toJson } from "../src/commands/drift.ts";

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
  });

  test("a page with footnotes pinned at two stale revisions", () => {
    const noaa = report("noaa", [stale("b0", "old", true), stale("b1", "new", true)]);
    expect(toJson([noaa]).pages_in_doubt).toBe(1);
    expect(text(noaa)).toContain("1 page(s) may have drifted");
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
});

describe("a page that only cites the source", () => {
  test("is labelled cited at, not verified at", () => {
    const noaa = report("noaa", [stale("b1", "b", true)]);
    expect(text(noaa)).toContain(`${PAGE} (cited at b1)`);
    const page = toJson([noaa]).sources[0]!.in_doubt[0]!;
    expect(page.cited_at).toBe("b1");
    expect(page.verified_at).toBeUndefined();
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
