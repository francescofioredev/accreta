import { expect, test } from "bun:test";
import {
  internalEdges,
  publishDayShare,
  reaches,
  roots,
  shortfalls,
  sustainedRate,
  unfetchedDays,
  type Day,
  type Edge,
} from "../scripts/adoption.ts";

/**
 * August 2026, as npm recorded it: 0.1.1 published on the 8th, 0.1.2 on the 9th, and 1,836
 * downloads with no human behind any of them. Kept as a fixture because it is the case the
 * report exists to read correctly, and because a report that cannot classify a known
 * answer cannot be trusted on an unknown one. The last two days are npm's reporting lag.
 */
const FIRST_DAY = "2026-08-08";
const SERIES: Record<string, number[]> = {
  accreta: [105, 165, 17, 13, 9, 6, 0, 9, 2, 10, 4, 2, 5, 3, 2, 2, 4, 0, 0],
  "@accreta/core": [124, 204, 23, 14, 11, 5, 0, 13, 5, 7, 31, 2, 5, 2, 2, 4, 3, 0, 0],
  "@accreta/mcp-server": [54, 170, 18, 12, 8, 5, 0, 12, 6, 7, 7, 2, 7, 2, 2, 5, 5, 0, 0],
  "@accreta/adapter-fs": [57, 196, 18, 13, 0, 5, 0, 10, 5, 7, 18, 2, 5, 2, 3, 4, 3, 0, 0],
  "@accreta/adapter-git": [64, 199, 18, 0, 11, 5, 0, 11, 5, 0, 18, 2, 5, 5, 3, 4, 3, 0, 0],
};
const PUBLISH_DAYS = new Set(["2026-08-08", "2026-08-09"]);
const COUNTED_TO = "2026-08-24";

function days(counts: number[]): Day[] {
  const start = new Date(`${FIRST_DAY}T00:00:00Z`);
  return counts.map((downloads, i) => {
    const day = new Date(start);
    day.setUTCDate(day.getUTCDate() + i);
    return { day: day.toISOString().slice(0, 10), downloads };
  });
}

const august = new Map(Object.entries(SERIES).map(([name, counts]) => [name, days(counts)]));
const totals = new Map(
  [...august].map(([name, series]) => [name, series.reduce((sum, d) => sum + d.downloads, 0)]),
);

const EDGES: Edge[] = [
  { dependent: "@accreta/adapter-fs", dependency: "@accreta/core" },
  { dependent: "@accreta/adapter-git", dependency: "@accreta/core" },
  { dependent: "accreta", dependency: "@accreta/core" },
  { dependent: "accreta", dependency: "@accreta/adapter-fs" },
  { dependent: "accreta", dependency: "@accreta/adapter-git" },
  { dependent: "@accreta/mcp-server", dependency: "@accreta/core" },
  { dependent: "@accreta/mcp-server", dependency: "@accreta/adapter-fs" },
  { dependent: "@accreta/mcp-server", dependency: "@accreta/adapter-git" },
];

test("the entry points are the two packages nobody depends on", () => {
  expect(roots([...totals.keys()], EDGES).sort()).toEqual(["@accreta/mcp-server", "accreta"]);
});

test("reachability follows the chain, not just the direct edges", () => {
  const chain: Edge[] = [
    { dependent: "a", dependency: "b" },
    { dependent: "b", dependency: "c" },
  ];
  expect([...reaches("a", chain)].sort()).toEqual(["b", "c"]);
});

test("a dependency counted fewer times than its entry points is short, and by how much", () => {
  const byName = new Map(shortfalls(totals, EDGES).map((s) => [s.dependency, s]));

  // 358 installs of the CLI and 322 of the server cannot happen without 680 of core.
  const core = byName.get("@accreta/core")!;
  expect(core.requiredBy.sort()).toEqual(["@accreta/mcp-server", "accreta"]);
  expect(core.required).toBe(680);
  expect(core.recorded).toBe(455);
  expect(core.slack).toBe(-225);

  for (const name of ["@accreta/adapter-fs", "@accreta/adapter-git"]) {
    expect(`${name} slack < 0`).toBe(`${name} ${byName.get(name)!.slack < 0 ? "slack < 0" : "ok"}`);
  }
});

test("the sum is taken over entry points, so a dependency of a dependency is not double counted", () => {
  // Every install here is an install of the CLI, and it explains all four numbers.
  const explained = new Map([
    ["accreta", 10],
    ["@accreta/core", 10],
    ["@accreta/adapter-fs", 10],
    ["@accreta/adapter-git", 10],
  ]);
  const edges = EDGES.filter((e) => e.dependent !== "@accreta/mcp-server");
  expect(shortfalls(explained, edges).every((s) => s.slack === 0)).toBe(true);
});

test("most of the traffic landed on the two publish days", () => {
  const share = publishDayShare([...august.values()].flat(), PUBLISH_DAYS);
  expect(share.total).toBe(1836);
  expect(share.onPublishDays).toBe(1338);
});

test("the rate away from a publish is under the floor where npm traffic means anything", () => {
  const rate = sustainedRate(august.get("accreta")!, PUBLISH_DAYS, COUNTED_TO);
  // The 15 days from the 10th to the 24th: publish days excluded, and the reporting lag with them.
  expect(rate.days).toBe(15);
  expect(rate.downloads).toBe(88);
  expect(rate.perDay).toBeLessThan(50);
});

test("a package fetched on a day its dependency was not is reported, with both counts", () => {
  const found = unfetchedDays(august, EDGES).filter((u) => u.day <= COUNTED_TO);

  const git11 = found.find(
    (u) =>
      u.day === "2026-08-11" &&
      u.dependent === "accreta" &&
      u.dependency === "@accreta/adapter-git",
  );
  expect(git11?.dependentDownloads).toBe(13);
  expect(found).toHaveLength(6);
});

test("the dependency graph is read from the manifests, not remembered here", () => {
  // The report's central claim is arithmetic over this graph. A graph that drifts from the
  // manifests would produce a confident number about a shape the packages no longer have.
  expect(
    internalEdges().sort(
      (a, b) => a.dependent.localeCompare(b.dependent) || a.dependency.localeCompare(b.dependency),
    ),
  ).toEqual(
    [...EDGES].sort(
      (a, b) => a.dependent.localeCompare(b.dependent) || a.dependency.localeCompare(b.dependency),
    ),
  );
});
