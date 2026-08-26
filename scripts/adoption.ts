#!/usr/bin/env bun
import { PUBLISHABLE, manifestOf } from "./check-version.ts";

/**
 * Does anyone actually use this?
 *
 * npm's download counters answer a narrower question than they appear to. They count
 * tarball fetches, they do not filter automation, and a publish draws a fixed tribute from
 * mirrors, analysis bots and security scanners whether or not a human ever hears about the
 * package. In August 2026 that produced 1,836 downloads across these five packages with no
 * human behind any of them, and establishing that took an afternoon of hand-run curl
 * against four different APIs.
 *
 * This does the same work in one command and prints its arithmetic instead of a verdict.
 * Every threshold it compares against is cited at its constant.
 *
 * One caveat applies throughout and is not repeated below: a fetch avoided by a warm npm
 * cache is a fetch the registry never counts, so every count here is a lower bound on
 * installs. That direction matters — it means a small number is weak evidence of absence,
 * while the shortfalls in WHAT INSTALLS WOULD REQUIRE are evidence that survives it.
 */

/**
 * npm on its own counters: "naive by design", with no effort spent filtering bot traffic.
 * https://blog.npmjs.org/post/92574016600/numeric-precision-matters-how-npm-download-counts-work.html
 */
const NOISE_FLOOR_PER_DAY = 50;

/**
 * What a single published version draws from automation alone, as measured by Tenable
 * while documenting download pumping.
 * https://www.tenable.com/blog/how-cyberattackers-inflate-malicious-package-npm-download-counts
 */
const AUTOMATED_PER_VERSION = { low: 100, high: 150 };

/**
 * npm's statistics lag a day or two behind, and the lag reads as zeros — the same shape as
 * a package nobody wants. Rather than hardcode the lag, ask a package that is never quiet:
 * its last non-zero day is as far as the registry has finished counting.
 */
const BELLWETHER = "react";

export interface Day {
  day: string;
  downloads: number;
}

/** A publishable package depending on another one in the same set. */
export interface Edge {
  dependent: string;
  dependency: string;
}

// ---------------------------------------------------------------------------
// Arithmetic. Pure, so test/adoption.test.ts can check it without a network.
// ---------------------------------------------------------------------------

/** Packages nothing else in the set depends on: the only ones a person installs on purpose. */
export function roots(names: string[], edges: Edge[]): string[] {
  return names.filter((name) => !edges.some((e) => e.dependency === name));
}

/** Everything `from` pulls in, directly or through another publishable package. */
export function reaches(from: string, edges: Edge[]): Set<string> {
  const found = new Set<string>();
  const queue = [from];
  while (queue.length > 0) {
    const current = queue.pop()!;
    for (const edge of edges.filter((e) => e.dependent === current)) {
      if (found.has(edge.dependency)) continue;
      found.add(edge.dependency);
      queue.push(edge.dependency);
    }
  }
  return found;
}

export interface Shortfall {
  dependency: string;
  requiredBy: string[];
  required: number;
  recorded: number;
  /** recorded - required. Negative is a contradiction, not a weak signal. */
  slack: number;
}

/**
 * What real installs would require of each dependency, against what the registry recorded.
 *
 * An install fetches the dependency tree in the same run, so a dependency cannot be
 * counted fewer times than the things that cannot be installed without it. The sum is
 * taken over root packages only: adding up every direct dependent would double count,
 * because an install of the CLI already accounts for the adapter's own need of core.
 */
export function shortfalls(totals: Map<string, number>, edges: Edge[]): Shortfall[] {
  const names = [...totals.keys()];
  const entryPoints = roots(names, edges);

  return names
    .filter((name) => !entryPoints.includes(name))
    .map((dependency) => {
      const requiredBy = entryPoints.filter((root) => reaches(root, edges).has(dependency));
      const required = requiredBy.reduce((sum, root) => sum + (totals.get(root) ?? 0), 0);
      const recorded = totals.get(dependency) ?? 0;
      return { dependency, requiredBy, required, recorded, slack: recorded - required };
    });
}

export interface UnfetchedDay {
  day: string;
  dependent: string;
  dependentDownloads: number;
  dependency: string;
}

/**
 * Days a package was fetched but something it cannot be installed without was not.
 *
 * Weaker than a shortfall, and deliberately named for what it observes rather than for a
 * conclusion: a warm cache explains one of these, where it does not explain a shortfall
 * spanning the whole window.
 */
export function unfetchedDays(series: Map<string, Day[]>, edges: Edge[]): UnfetchedDay[] {
  const on = (name: string, day: string) =>
    series.get(name)?.find((d) => d.day === day)?.downloads ?? 0;

  const found: UnfetchedDay[] = [];
  for (const { dependent, dependency } of edges) {
    for (const { day, downloads } of series.get(dependent) ?? []) {
      if (downloads > 0 && on(dependency, day) === 0) {
        found.push({ day, dependent, dependentDownloads: downloads, dependency });
      }
    }
  }
  return found.sort((a, b) => a.day.localeCompare(b.day));
}

export function publishDayShare(
  series: Day[],
  publishDays: Set<string>,
): { onPublishDays: number; total: number } {
  return {
    onPublishDays: series
      .filter((d) => publishDays.has(d.day))
      .reduce((sum, d) => sum + d.downloads, 0),
    total: series.reduce((sum, d) => sum + d.downloads, 0),
  };
}

/**
 * The rate away from a publish, which is the only rate that could carry a human.
 *
 * Publish days are excluded because the tribute lands on them; days the registry has not
 * finished counting are excluded because their zeros are lag, not silence; and days before
 * the first publish are excluded because nothing existed to download.
 */
export function sustainedRate(
  series: Day[],
  publishDays: Set<string>,
  lastCountedDay: string,
): { days: number; downloads: number; perDay: number } {
  const firstPublish = [...publishDays].sort()[0] ?? "";
  const window = series.filter(
    (d) => d.day > firstPublish && d.day <= lastCountedDay && !publishDays.has(d.day),
  );
  const downloads = window.reduce((sum, d) => sum + d.downloads, 0);
  return {
    days: window.length,
    downloads,
    perDay: window.length === 0 ? 0 : downloads / window.length,
  };
}

// ---------------------------------------------------------------------------
// Reading the world. Thin, and asserts nothing of its own.
// ---------------------------------------------------------------------------

/** The dependency graph as the manifests state it, rather than as this script remembers it. */
export function internalEdges(): Edge[] {
  const manifests = PUBLISHABLE.map(manifestOf);
  const publishable = new Set(manifests.map((m) => m.name));
  return manifests.flatMap((m) =>
    Object.keys(m.dependencies ?? {})
      .filter((dep) => publishable.has(dep))
      .map((dependency) => ({ dependent: m.name, dependency })),
  );
}

/** ecosyste.ms rate-limits by hanging, so nothing here is allowed to wait indefinitely. */
const REQUEST_TIMEOUT_MS = 8_000;

async function json(url: string): Promise<any> {
  const response = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText} for ${url}`);
  return response.json();
}

const encode = (name: string) => name.replace("/", "%2F");

async function fetchRange(name: string, from: string, to: string): Promise<Day[]> {
  const body = await json(`https://api.npmjs.org/downloads/range/${from}:${to}/${encode(name)}`);
  return body.downloads as Day[];
}

/** Publish days, derived from the registry rather than remembered, one per version. */
async function fetchPublishDays(name: string): Promise<Map<string, string>> {
  const { time } = await json(`https://registry.npmjs.org/${encode(name)}`);
  const versions = new Map<string, string>();
  for (const [version, stamp] of Object.entries(time as Record<string, string>)) {
    if (version === "created" || version === "modified") continue;
    versions.set(version, stamp.slice(0, 10));
  }
  return versions;
}

/**
 * Uses ecosyste.ms' lookup endpoint rather than its by-name path: a scoped name in the
 * path never completes the connection, however the slash is encoded, while the same name
 * as a query parameter answers in under a second.
 */
async function fetchDependents(name: string): Promise<{ repos: number; packages: number } | null> {
  const query = new URLSearchParams({ ecosystem: "npm", name });
  try {
    const [found] = await json(`https://packages.ecosyste.ms/api/v1/packages/lookup?${query}`);
    if (found === undefined) return null;
    return {
      repos: found.dependent_repos_count ?? 0,
      packages: found.dependent_packages_count ?? 0,
    };
  } catch {
    return null;
  }
}

async function lastCountedDay(from: string, to: string): Promise<string> {
  const series = await fetchRange(BELLWETHER, from, to);
  const counted = series.filter((d) => d.downloads > 0);
  return counted[counted.length - 1]?.day ?? to;
}

/** owner/repo, taken from the manifest that already has to name it correctly for npm. */
function repoSlug(): string | null {
  const url: string = manifestOf("packages/cli").repository?.url ?? "";
  return url.match(/github\.com\/([^/]+\/[^/.]+)/)?.[1] ?? null;
}

/** GitHub's traffic API needs push rights, so this is skipped rather than failed on. */
async function gh(path: string): Promise<any | null> {
  try {
    const proc = Bun.spawn(["gh", "api", path], { stdout: "pipe", stderr: "ignore" });
    const out = await new Response(proc.stdout).text();
    return (await proc.exited) === 0 ? JSON.parse(out) : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const num = (n: number) => n.toLocaleString("en-US");
const pct = (part: number, whole: number) =>
  whole === 0 ? "—" : `${Math.round((part / whole) * 100)}%`;
const short = (name: string) => name.replace("@accreta/", "@");

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

async function main() {
  const names = PUBLISHABLE.map((dir) => manifestOf(dir).name);
  const edges = internalEdges();

  const versionDays = await fetchPublishDays(names[0]!);
  const publishDays = new Set(versionDays.values());
  const from = [...publishDays].sort()[0]!;
  const to = today();

  const counted = await lastCountedDay(from, to);
  const series = new Map(
    await Promise.all(names.map(async (name) => [name, await fetchRange(name, from, to)] as const)),
  );

  const totals = new Map(
    names.map((name) => [name, series.get(name)!.reduce((sum, d) => sum + d.downloads, 0)]),
  );
  const grandTotal = [...totals.values()].reduce((a, b) => a + b, 0);

  console.log(`accreta adoption — measured ${to}\n`);

  console.log("WINDOW");
  console.log(`  versions      ${[...versionDays.keys()].join(", ")}`);
  console.log(`  published     ${[...publishDays].sort().join(", ")}`);
  console.log(`  counted to    ${counted}  (npm's reporting lag, probed with ${BELLWETHER})`);

  console.log("\nDAILY DOWNLOADS");
  console.log(`  ${"day".padEnd(10)}${names.map((n) => short(n).padStart(13)).join("")}`);
  for (const { day } of series.get(names[0]!)!) {
    const cells = names.map((n) => {
      const value = series.get(n)!.find((d) => d.day === day)?.downloads ?? 0;
      return (day > counted ? "·" : num(value)).padStart(13);
    });
    console.log(`  ${day}${cells.join("")}`);
  }
  console.log(
    `  ${"total".padEnd(10)}${names.map((n) => num(totals.get(n)!).padStart(13)).join("")}`,
  );
  console.log(`  ${num(grandTotal)} across ${names.length} packages`);

  console.log("\nWHAT THE PUBLISHES EXPLAIN");
  const share = publishDayShare(
    names.flatMap((n) => series.get(n)!),
    publishDays,
  );
  const baseline = {
    low: AUTOMATED_PER_VERSION.low * versionDays.size * names.length,
    high: AUTOMATED_PER_VERSION.high * versionDays.size * names.length,
  };
  console.log(
    `  on publish days     ${num(share.onPublishDays)} of ${num(share.total)}  (${pct(share.onPublishDays, share.total)})`,
  );
  console.log(
    `  automated baseline  ${num(baseline.low)}–${num(baseline.high)} for ${versionDays.size} versions x ${names.length} packages   [Tenable]`,
  );
  for (const name of names) {
    const rate = sustainedRate(series.get(name)!, publishDays, counted);
    console.log(
      `  ${short(name).padEnd(18)}${rate.perDay.toFixed(1)}/day over ${rate.days} days away from a publish   (floor ${NOISE_FLOOR_PER_DAY}/day)  [npm]`,
    );
  }

  console.log("\nWHAT INSTALLS WOULD REQUIRE");
  for (const s of shortfalls(totals, edges)) {
    console.log(
      `  ${short(s.dependency).padEnd(14)} >= ${num(s.required).padStart(6)} (${s.requiredBy.map(short).join(" + ")}), recorded ${num(s.recorded).padStart(6)}   ${s.slack >= 0 ? "ok" : num(s.slack)}`,
    );
  }
  console.log("  A negative figure is traffic that did not come from `npm install`.");

  const unfetched = unfetchedDays(series, edges).filter((u) => u.day <= counted);
  console.log(
    `\nDAYS A DEPENDENCY WENT UNFETCHED  (${unfetched.length}; a warm cache explains one)`,
  );
  for (const u of unfetched.slice(0, 10)) {
    console.log(
      `  ${u.day}  ${short(u.dependent)} ${num(u.dependentDownloads)}, ${short(u.dependency)} 0`,
    );
  }

  console.log("\nDEPENDENTS");
  const dependents = await Promise.all(names.map((name) => fetchDependents(name)));
  const answered = dependents.filter((d) => d != null);
  names.forEach((name, i) => {
    const d = dependents[i];
    console.log(
      `  ${short(name).padEnd(14)} ${d == null ? "ecosyste.ms did not answer" : `${d.repos} repos, ${d.packages} packages`}`,
    );
  });
  const dependentRepos = answered.reduce((sum, d) => sum + d.repos, 0);

  console.log("\nGITHUB TRAFFIC  (last 14 days, the most the API keeps)");
  const slug = repoSlug();
  const views = slug && (await gh(`repos/${slug}/traffic/views`));
  const clones = slug && (await gh(`repos/${slug}/traffic/clones`));
  const referrers: { referrer: string; count: number; uniques: number }[] =
    (slug && (await gh(`repos/${slug}/traffic/popular/referrers`))) || [];
  let outsideReferrers: number | null = null;
  if (!views) {
    console.log("  skipped: needs `gh` authenticated with push rights on the repository");
  } else {
    console.log(`  views    ${views.count} (${views.uniques} unique)`);
    console.log(`  clones   ${clones?.count ?? "?"} (${clones?.uniques ?? "?"} unique)`);
    outsideReferrers = referrers.filter((r) => r.referrer !== "github.com").length;
    console.log(
      `  referrers ${referrers.length === 0 ? "none" : referrers.map((r) => `${r.referrer} ${r.count}/${r.uniques}`).join(", ")}`,
    );
  }

  // Three things a real user leaves behind. Printed as a checklist rather than a verdict,
  // so that the day one of them flips, the report says so without anyone re-reading it.
  //
  // An unanswered API prints `?`, never `no`. A source that did not reply is not evidence
  // of absence, and a report that rounds one down to the other is worse than no report.
  console.log("\nWHAT WOULD CHANGE THE ANSWER");
  const loudest = Math.max(
    ...names.map((n) => sustainedRate(series.get(n)!, publishDays, counted).perDay),
  );
  const check = (present: boolean | null) => (present === null ? "? " : present ? "YES" : "no");
  console.log(
    `  ${check(loudest >= NOISE_FLOOR_PER_DAY)}   a sustained rate at or above ${NOISE_FLOOR_PER_DAY}/day (loudest: ${loudest.toFixed(1)})`,
  );
  console.log(
    `  ${check(answered.length === 0 ? null : dependentRepos > 0)}   a repository that depends on it (${dependentRepos} across ${answered.length} of ${names.length} packages)`,
  );
  console.log(
    `  ${check(outsideReferrers === null ? null : outsideReferrers > 0)}   a referrer other than github.com (${outsideReferrers ?? "not read"})`,
  );
}

if (import.meta.main) {
  await main();
}
