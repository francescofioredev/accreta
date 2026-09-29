import { expect, test } from "bun:test";
import {
  analyse,
  graphOn,
  internalEdges,
  publishDayShare,
  reaches,
  roots,
  shortfalls,
  sustainedRate,
  unfetchedDays,
  type Day,
  type Edge,
  type Packument,
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

/**
 * The graph as it was when those downloads were recorded, and frozen with them.
 *
 * It is not the graph the manifests describe today, and it must not be updated to match:
 * the arithmetic below reads August, and reading August through a later shape would
 * attribute those downloads to edges that did not exist yet. `CURRENT_EDGES` is the one
 * that tracks the manifests.
 */
const AUGUST_EDGES: Edge[] = [
  { dependent: "@accreta/adapter-fs", dependency: "@accreta/core" },
  { dependent: "@accreta/adapter-git", dependency: "@accreta/core" },
  { dependent: "accreta", dependency: "@accreta/core" },
  { dependent: "accreta", dependency: "@accreta/adapter-fs" },
  { dependent: "accreta", dependency: "@accreta/adapter-git" },
  { dependent: "@accreta/mcp-server", dependency: "@accreta/core" },
  { dependent: "@accreta/mcp-server", dependency: "@accreta/adapter-fs" },
  { dependent: "@accreta/mcp-server", dependency: "@accreta/adapter-git" },
];

/** What the manifests say now. Update this when a package gains or loses a dependency. */
const CURRENT_EDGES: Edge[] = [
  { dependent: "@accreta/adapter-fs", dependency: "@accreta/core" },
  { dependent: "@accreta/adapter-git", dependency: "@accreta/core" },
  { dependent: "@accreta/adapter-delegated", dependency: "@accreta/core" },
  { dependent: "@accreta/adapters", dependency: "@accreta/core" },
  { dependent: "@accreta/adapters", dependency: "@accreta/adapter-delegated" },
  { dependent: "@accreta/adapters", dependency: "@accreta/adapter-fs" },
  { dependent: "@accreta/adapters", dependency: "@accreta/adapter-git" },
  { dependent: "accreta", dependency: "@accreta/core" },
  { dependent: "accreta", dependency: "@accreta/adapters" },
  { dependent: "accreta", dependency: "@accreta/mcp-server" },
  { dependent: "@accreta/mcp-server", dependency: "@accreta/core" },
  { dependent: "@accreta/mcp-server", dependency: "@accreta/adapters" },
];

test("the entry points are the two packages nobody depends on", () => {
  expect(roots([...totals.keys()], AUGUST_EDGES).sort()).toEqual([
    "@accreta/mcp-server",
    "accreta",
  ]);
});

test("reachability follows the chain, not just the direct edges", () => {
  const chain: Edge[] = [
    { dependent: "a", dependency: "b" },
    { dependent: "b", dependency: "c" },
  ];
  expect([...reaches("a", chain)].sort()).toEqual(["b", "c"]);
});

test("a dependency counted fewer times than its entry points is short, and by how much", () => {
  const byName = new Map(shortfalls(totals, AUGUST_EDGES).map((s) => [s.dependency, s]));

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
  const edges = AUGUST_EDGES.filter((e) => e.dependent !== "@accreta/mcp-server");
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
  const found = unfetchedDays(august, AUGUST_EDGES).filter((u) => u.day <= COUNTED_TO);

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
    [...CURRENT_EDGES].sort(
      (a, b) => a.dependent.localeCompare(b.dependent) || a.dependency.localeCompare(b.dependency),
    ),
  );
});

/** Registry records where each listed package ships `version` declaring the edges given for it. */
function registry(
  releases: { version: string; at: string; names: string[]; edges: Edge[] }[],
): Map<string, Packument> {
  const packuments = new Map<string, Packument>();
  for (const { version, at, names, edges } of releases) {
    for (const name of names) {
      const packument = packuments.get(name) ?? { time: {}, versions: {} };
      packument.time[version] = at;
      packument.versions[version] = {
        dependencies: Object.fromEntries(
          edges.filter((e) => e.dependent === name).map((e) => [e.dependency, version]),
        ),
      };
      packuments.set(name, packument);
    }
  }
  return packuments;
}

const AUGUST_NAMES = Object.keys(SERIES);
const releases = registry([
  { version: "0.1.1", at: "2026-08-08T10:00:00Z", names: AUGUST_NAMES, edges: AUGUST_EDGES },
  { version: "0.1.2", at: "2026-08-09T10:00:00Z", names: AUGUST_NAMES, edges: AUGUST_EDGES },
  {
    version: "0.2.0",
    at: "2026-09-02T10:00:00Z",
    names: [...AUGUST_NAMES, "@accreta/adapters"],
    edges: CURRENT_EDGES,
  },
]);
const withSeptember = new Map<string, Day[]>([
  ...[...august].map(([name, series]): [string, Day[]] => [
    name,
    [...series, { day: "2026-09-02", downloads: 10 }],
  ]),
  ["@accreta/adapters", [{ day: "2026-09-02", downloads: 10 }]],
]);

test("an edge counts only from the release that added it, so August keeps its shortfall", () => {
  // Today's graph makes the server a dependency of the CLI; read back over August it hides core's gap.
  const flat = new Map(
    [...withSeptember].map(([name, s]) => [name, s.reduce((sum, d) => sum + d.downloads, 0)]),
  );
  expect(shortfalls(flat, CURRENT_EDGES).find((s) => s.dependency === "@accreta/core")!.slack).toBe(
    97,
  );

  const core = analyse(withSeptember, releases).shortfalls.find(
    (s) => s.dependency === "@accreta/core",
  )!;
  expect(core.slack).toBe(-225);
  expect(core.requiredBy.sort()).toEqual(["@accreta/mcp-server", "accreta"]);
});

test("a dependency added later does not flag August days as unfetched", () => {
  const anachronistic = unfetchedDays(withSeptember, CURRENT_EDGES).filter(
    (u) => u.dependency === "@accreta/adapters",
  );
  expect(anachronistic.length).toBeGreaterThan(0);

  const unfetched = analyse(withSeptember, releases).unfetched;
  expect(unfetched.filter((u) => u.dependency === "@accreta/adapters")).toEqual([]);
  expect(unfetched.filter((u) => u.day <= COUNTED_TO)).toEqual(
    unfetchedDays(august, AUGUST_EDGES).filter((u) => u.day <= COUNTED_TO),
  );
});

test("a release that stopped after core leaves the day on the previous graph", () => {
  const partial = registry([
    {
      version: "0.2.0",
      at: "2026-09-01T10:00:00Z",
      names: ["accreta", "@accreta/core"],
      edges: [{ dependent: "accreta", dependency: "@accreta/core" }],
    },
    { version: "0.2.1", at: "2026-09-02T10:00:00Z", names: ["@accreta/core"], edges: [] },
  ]);
  expect(graphOn("2026-09-02", partial)).toEqual([
    { dependent: "accreta", dependency: "@accreta/core" },
  ]);

  const series = new Map<string, Day[]>([
    [
      "accreta",
      [
        { day: "2026-09-01", downloads: 10 },
        { day: "2026-09-02", downloads: 10 },
      ],
    ],
    [
      "@accreta/core",
      [
        { day: "2026-09-01", downloads: 10 },
        { day: "2026-09-02", downloads: 0 },
      ],
    ],
  ]);
  const core = analyse(series, partial).shortfalls.find((s) => s.dependency === "@accreta/core")!;
  expect(core.required).toBe(20);
  expect(core.slack).toBe(-10);
});

test("downloads on a day with no release are refused rather than dropped", () => {
  const series = new Map([["accreta", [{ day: "2026-08-01", downloads: 3 }]]]);
  expect(() => analyse(series, releases)).toThrow("before any release");
});
