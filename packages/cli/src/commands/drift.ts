import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  openIndex,
  pageChanges,
  type CitedChange,
  type DriftReport,
  type PageChange,
  type RefusedCitation,
  type StaleRevision,
  type UnresolvableRevision,
} from "@accreta/core";
import {
  countUnchecked,
  detectDriftEach,
  noSourceNamed,
  uncheckedPages,
  type UncheckedSource,
} from "@accreta/adapters";
import { findWorkspace } from "../workspace.ts";
import {
  DRIFT_NOTICE,
  loadSources,
  printable,
  printableBlock,
  printableMessage,
  provenance,
  type CommandContext,
} from "./shared.ts";

export type DriftFormat = "text" | "json" | "github";

export interface DriftOptions {
  format: DriftFormat;
  /** A `drift --json` report from the base branch, to tell what this change put in doubt. */
  base?: string;
  /** Check this source alone, as `check_drift {source}` does. */
  source?: string;
}

/**
 * Pair drift's flags with their values in the raw arguments. `COMMAND_ARGS` has already refused
 * any flag drift does not take; what is left to refuse is a value without its flag.
 */
export function driftOptions(args: readonly string[]): DriftOptions {
  const options: DriftOptions = { format: "text" };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const at = arg.startsWith("--") ? arg.indexOf("=") : -1;
    const name = at > 0 ? arg.slice(0, at) : arg;
    const value = () => (at > 0 ? arg.slice(at + 1) : args[++i]);
    if (name === "--strict") continue;
    if (name === "--json") {
      options.format = "json";
    } else if (name === "--format") {
      const format = value();
      if (format !== "text" && format !== "json" && format !== "github") {
        throw new Error(`--format takes text, json or github, not "${format ?? ""}".`);
      }
      options.format = format;
    } else if (name === "--base") {
      const path = value();
      if (!path || path.startsWith("--")) {
        throw new Error("--base takes the path of a `drift --json` report.");
      }
      options.base = path;
    } else if (name === "--source") {
      const id = value();
      if (!id || id.startsWith("--")) throw new Error("--source takes the id of a source.");
      if (options.source !== undefined) throw new Error("drift takes one --source.");
      options.source = id;
    } else {
      throw new Error(`drift does not take "${arg}".`);
    }
  }
  return options;
}

export async function drift(
  ctx: CommandContext,
  args: readonly string[] = [],
  strict = false,
): Promise<number> {
  const workspace = findWorkspace(ctx.cwd);
  if (!existsSync(workspace.indexPath)) {
    throw new Error(`No index at ${workspace.indexPath}. Run \`accreta reindex\` first.`);
  }
  let options: DriftOptions;
  let base: BaseKeys | undefined;
  try {
    options = driftOptions(args);
    base = options.base ? readBase(resolve(ctx.cwd, options.base), options.source) : undefined;
  } catch (error) {
    // 2, as for any refused argument: 1 already means drift found something.
    ctx.err(printableMessage(error instanceof Error ? error.message : String(error)));
    return 2;
  }

  const loaded = loadSources(workspace);
  if (options.source !== undefined) {
    const id = options.source;
    const broken = loaded.unloaded.filter((u) => u.id === id);
    // As check_drift: a named source that did not load is reported alone; otherwise every
    // broken declaration still is, so the run cannot pass over one.
    if (broken.length > 0) {
      loaded.sources = [];
      loaded.unloaded = broken;
    } else {
      const known = loaded.sources.map((adapter) => adapter.id);
      loaded.sources = loaded.sources.filter((adapter) => adapter.id === id);
      if (loaded.sources.length === 0) {
        ctx.err(printable(noSourceNamed(id, known, loaded.unloaded)));
        return 2;
      }
    }
  }
  const reports: DriftReport[] = [];
  let unloaded: UnloadedEntry[] = [];
  if (loaded.sources.length > 0 || loaded.unloaded.length > 0) {
    const db = openIndex(workspace.indexPath, { readonly: true });
    try {
      const each = await detectDriftEach(db, loaded.sources, loaded.files);
      reports.push(...each.reports);
      unloaded = markUnloaded(countUnchecked(db, [...loaded.unloaded, ...each.unreadable]), base);
    } finally {
      db.close();
    }
  }

  const compared = base && toJson(reports, base, unloaded);
  if (options.format === "json") {
    const json = compared || toJson(reports, base, unloaded);
    ctx.out(JSON.stringify(options.source ? { ...json, source: options.source } : json, null, 2));
  } else if (options.format === "github") {
    ctx.out(toGithub(reports, base, GITHUB_BODY_LIMIT, unloaded));
  } else {
    for (const source of unloaded) {
      const when = source.on_base ? " on the base branch either" : "";
      ctx.out(
        `${printable(source.file)} — ${unchecked(source)}${when}, so ${uncheckedPages(source.pages)}`,
      );
      ctx.out(`  ${printable(source.reason)}`);
    }
    if (reports.length === 0 && unloaded.length === 0) {
      ctx.out("No sources declared in sources/. Nothing to check.");
    } else {
      if (compared) ctx.out(againstBase(compared));
      printReports(ctx, reports);
    }
  }

  // "I cannot tell", like `unresolvable`: a typo in `type` must not turn a failing run green.
  const failed =
    base && compared
      ? failsAgainst(compared, base, reports, strict)
      : reports.some((report) => fails(report, strict)) || unloaded.length > 0;
  return failed ? 1 : 0;
}

/** Text mode's verdict with `--base`, since its rows do not say which pages the base had. */
function againstBase(json: DriftJson): string {
  const kept = json.pages_in_doubt - json.pages_newly_in_doubt;
  return `${json.pages_newly_in_doubt} page(s) newly in doubt; ${kept} already in doubt on the base branch`;
}

/** With `--base`, only what the change put in doubt fails, as the action counts it. */
function failsAgainst(
  json: DriftJson,
  base: BaseKeys,
  reports: DriftReport[],
  strict: boolean,
): boolean {
  if (json.pages_newly_in_doubt + json.pages_newly_unplaceable + json.sources_newly_unloaded > 0) {
    return true;
  }
  return strict && reports.some((r) => uncheckedKeys(r.sourceId, r).some((key) => !base.has(key)));
}

function fails(report: DriftReport, strict: boolean): boolean {
  if (report.delegated) {
    const pending = report.delegated.pending.some((entry) => entry.pages.length > 0);
    return strict && (pending || report.unverifiable.length > 0);
  }
  return (
    report.stale.length > 0 ||
    report.unresolvable.length > 0 ||
    (strict && report.unverifiable.length > 0)
  );
}

// Each page once: sources and pinned revisions can name the same page more than once.
const distinct = (pages: string[]) => new Set(pages).size;
const distinctPages = (groups: readonly { pages: string[] }[]) =>
  distinct(groups.flatMap((group) => group.pages));

/** "verified at" for a page of the source, "cited at" for one here only through a pinned citation. */
const atLabel = (group: { citedOnly?: string[] }, page: string) =>
  group.citedOnly?.includes(page) ? "cited at" : "verified at";

type Unpinned = NonNullable<DriftReport["unpinned"]>;

/** Pages recording no revision, apart from those whose only fault is an unpinned citation. */
function unverifiedApart(unverifiable: string[], unpinned: Unpinned = []) {
  const pinless = new Set(unpinned.map((u) => u.page));
  return { none: unverifiable.filter((page) => !pinless.has(page)), pinless: pinless.size };
}

const howToPin = (u: Unpinned[number]) =>
  u.footnote === null
    ? { cited: "canonical_source", fix: "add a pinned footnote to the same place" }
    : { cited: `[^${u.footnote}]`, fix: "pin it to a revision" };

function printUnverifiable(ctx: Pick<CommandContext, "out">, report: DriftReport): void {
  const { none, pinless } = unverifiedApart(report.unverifiable, report.unpinned);
  if (none.length > 0) ctx.out(`  ${none.length} page(s) record no revision at all`);
  if (pinless === 0) return;
  ctx.out(`  ${pinless} page(s) cite this source without a revision:`);
  for (const u of report.unpinned ?? []) {
    const { cited, fix } = howToPin(u);
    ctx.out(`    ${printable(u.page)} ${printable(cited)} names no revision: ${fix}`);
  }
}

/** Each source's report, then, with several, the distinct total that `--json` reports. */
export function printReports(ctx: Pick<CommandContext, "out">, reports: DriftReport[]): void {
  for (const report of reports) printText(ctx, report);
  if (reports.length < 2) return;
  // A page in doubt under two sources is counted under each above, but once here.
  const total = toJson(reports).pages_in_doubt;
  // A bare 0 would close a failing run on what reads as all clear.
  if (total > 0) ctx.out(`${total} page(s) in doubt across ${reports.length} sources`);
}

export function printText(ctx: Pick<CommandContext, "out">, report: DriftReport): void {
  // A source only the agent can reach produces a work order rather than a
  // verdict, so it is printed on its own terms and skips the outcomes below
  // — every one of which would imply somebody had looked.
  if (report.delegated) {
    const work = report.delegated;
    const pageCount = distinctPages(work.pending);
    ctx.out(
      `${printable(report.sourceId)} — read through ${printable(work.via)} by the agent, not by accreta`,
    );

    if (pageCount > 0) {
      ctx.out(`  ${pageCount} page(s) for the agent to re-verify there:`);
      for (const entry of work.pending) {
        for (const path of entry.pages) {
          ctx.out(`    ${printable(path)} (${atLabel(entry, path)} ${printable(entry.revision)})`);
        }
      }
    } else {
      ctx.out("  no pages cite it yet");
    }
    printUnverifiable(ctx, report);
    ctx.out("  in scope:");
    // Marked, not just indented: drift runs in CI, and the runner reads `::` after leading space.
    for (const line of printableBlock(work.guidance.trimEnd()).split("\n"))
      ctx.out(`    | ${line}`);
    return;
  }

  ctx.out(`${printable(report.sourceId)} @ ${printable(String(report.currentRevision))}`);

  if (report.stale.length > 0) {
    const rows = report.stale
      .flatMap((entry) => {
        const doubt = pageChanges(entry);
        return entry.pages.map((page) => ({ entry, page, doubt: doubt ? doubt.get(page)! : null }));
      })
      .toSorted((a, b) => rank(a.doubt) - rank(b.doubt));
    // A page pinned at several revisions goes under its worst one, so each page counts once.
    const worst = new Map<string, number>();
    for (const row of rows) {
      worst.set(row.page, Math.min(worst.get(row.page) ?? Infinity, rank(row.doubt)));
    }
    const group = (...ranks: number[]) =>
      rows.filter((row) => ranks.includes(worst.get(row.page)!));
    const inDoubt = group(rank("changed"));
    const rest = group(rank("moved"), rank("untouched"), rank("uncited"));
    if (inDoubt.length === 0) {
      // Without --base drift still fails on these, so the line must not read as all clear.
      const count = distinct(rest.map((row) => row.page));
      ctx.out(
        count > 0 ? `  no page in doubt; ${count} to re-pin or re-verify` : "  no page in doubt",
      );
    }
    printStale(ctx, "page(s) in doubt", inDoubt);
    printStale(ctx, "page(s) to re-pin, cited lines moved", group(rank("moved")));
    printStale(
      ctx,
      "page(s) behind the source, no cited line changed",
      group(rank("untouched"), rank("uncited")),
    );
  }
  // Reported separately because "I cannot tell" is not "out of date", and
  // collapsing them would misrepresent what the system actually knows.
  if (report.unresolvable.length > 0) {
    // Each page once, as in `pages_unplaceable`: one page can rest on two such revisions.
    const pageCount = distinctPages(report.unresolvable);
    const revisions = report.unresolvable.length;
    ctx.out(`  ${pageCount} page(s) rest on ${revisions} revision(s) this source cannot place:`);
    for (const entry of report.unresolvable) {
      ctx.out(`    ${printable(entry.revision)}:`);
      for (const path of entry.pages) {
        ctx.out(
          `      ${printable(path)} (${entry.citedOnly?.includes(path) ? "cited" : "verified"})`,
        );
      }
    }
    ctx.out("    a shallow clone or rewritten history does this: fetch the full history,");
    ctx.out("    or re-verify these pages from scratch. So does a ref such as HEAD where a");
    ctx.out(
      "    revision belongs, which `accreta lint` names: re-cite a cited page, re-verify a verified one",
    );
  }
  printUnverifiable(ctx, report);
  if (report.stale.length === 0 && report.unresolvable.length === 0) {
    ctx.out("  up to date");
  }
}

const repinText = (c: CitedChange) =>
  c.change.status === "moved" ? [printable(`${c.path}#${c.locator} → ${c.change.locator}`)] : [];

const DOUBT_ORDER: PageChange[] = ["changed", "moved", "untouched", "uncited"];

// null: the source can only say which files changed, so the page is in doubt, as in --json.
const rank = (doubt: PageChange | null) =>
  doubt === null ? DOUBT_ORDER.indexOf("changed") : DOUBT_ORDER.indexOf(doubt);

interface StaleRow {
  entry: StaleRevision;
  page: string;
  doubt: PageChange | null;
}

/** Each page counted once, as pins can split it across revisions. */
function printStale(ctx: Pick<CommandContext, "out">, label: string, rows: StaleRow[]): void {
  if (rows.length === 0) return;
  ctx.out(`  ${distinct(rows.map((row) => row.page))} ${label}:`);
  for (const { entry, page, doubt } of rows) {
    const refused = entry.refused?.[page];
    const why = doubt
      ? ` — ${explainDoubt(doubt, entry, page)}`
      : refused
        ? ` — ${refusedText(refused)}`
        : "";
    ctx.out(`    ${printable(page)} (${atLabel(entry, page)} ${printable(entry.revision)})${why}`);
  }
}

const refusedText = (refused: readonly { refused: string }[]) =>
  `the source refuses ${refused.map((c) => printable(c.refused)).join("; ")}`;

function explainDoubt(doubt: PageChange, entry: StaleRevision, page: string): string {
  const mine = (entry.citations ?? []).filter((c) => c.page === page);
  const count = (status: string) => mine.filter((c) => c.change.status === status).length;
  switch (doubt) {
    case "changed": {
      const refused = mine.filter(
        (c): c is RefusedCitation & CitedChange => c.refused !== undefined,
      );
      const ranges = count("touched") + count("unknown") - refused.length;
      const moved = mine.flatMap(repinText);
      return [
        ranges > 0 ? `${ranges} cited range(s) changed` : "",
        refused.length > 0 ? refusedText(refused) : "",
        moved.length > 0 ? `re-pin ${moved.join(", ")}` : "",
      ]
        .filter(Boolean)
        .join("; ");
    }
    case "moved":
      return `re-pin ${mine.flatMap(repinText).join(", ")}`;
    case "untouched":
      return "cited lines unchanged";
    case "uncited":
      return "cites none of the changed files";
  }
}

/** A page in doubt. `citations` is null when the source can only say which files changed. */
interface DoubtedPage {
  page: string;
  /** For a page of the source: the revision it was verified at. */
  verified_at?: string;
  /** Instead, for a page here only through a citation pinned at this revision. */
  cited_at?: string;
  citations: DoubtedCitation[] | null;
  /** The changed files; for a page with `cited_at`, only those it cites. */
  changed_paths?: string[];
  /** Instead, for a page with `cited_at` here only because the source refuses its citations. */
  refused?: RefusedCitation[];
  /** With `--base`, for a page the source can only judge per file. */
  on_base?: boolean;
}

interface DoubtedCitation {
  footnote: string | null;
  path: string;
  locator: string | null;
  /** The revision the locator's lines belong to. */
  cited_at: string;
  change: "touched" | "unknown";
  /** Why the source refuses the place, when that is why its change is unknown. */
  refused?: string;
  /** With `--base`: the base branch already had this citation in doubt. */
  on_base?: boolean;
}

/** Moved citations of a page; the page may also be in `in_doubt` for its other citations. */
interface RepinPage {
  page: string;
  verified_at?: string;
  cited_at?: string;
  citations: {
    footnote: string | null;
    path: string;
    locator: string;
    cited_at: string;
    now: string;
  }[];
}

interface SourceVerdict {
  source_id: string;
  current_revision: string | null;
  in_doubt: DoubtedPage[];
  /** Overlaps `in_doubt` by page, never by citation: do not add the two page counts. */
  repin: RepinPage[];
  /** Pages on a stale revision whose cited lines are untouched: lower in doubt, not verified. */
  other_stale_pages: number;
  unresolvable: UnplacedJson[];
  unverifiable: string[];
  /** Of `unverifiable`, pages of other sources whose citations here name no revision. */
  unpinned: Unpinned;
  delegated: { via: string; pending: UnplacedJson[] } | null;
}

/** An `UnresolvableRevision` in check_drift's snake case. */
interface UnplacedJson {
  revision: string;
  pages: string[];
  cited_only?: string[];
}

const unplacedJson = (group: UnresolvableRevision): UnplacedJson => ({
  revision: group.revision,
  pages: group.pages,
  cited_only: group.citedOnly,
});

interface DriftJson {
  pages_in_doubt: number;
  /** Pages with a citation in doubt that the base report did not have; all of them without one. */
  pages_newly_in_doubt: number;
  pages_unplaceable: number;
  /** Unplaceable pages the base report did not have at the same revision; all of them without one. */
  pages_newly_unplaceable: number;
  sources: SourceVerdict[];
  /** Declarations that did not build; nothing citing them was checked. */
  unloaded_sources: UnloadedEntry[];
  /** Of those, the ones the base report did not have; all of them without one. */
  sources_newly_unloaded: number;
  /** With `--source`: the one source this report checked. */
  source?: string;
  _provenance: ReturnType<typeof provenance>;
}

// check_drift's DRIFT_FIELDS in this shape. `now` is the adapter's.
const DRIFT_FIELDS = [
  "sources[].in_doubt[].page",
  "sources[].in_doubt[].verified_at",
  "sources[].in_doubt[].cited_at",
  "sources[].in_doubt[].changed_paths",
  "sources[].in_doubt[].citations[].footnote",
  "sources[].in_doubt[].citations[].path",
  "sources[].in_doubt[].citations[].locator",
  "sources[].in_doubt[].citations[].cited_at",
  // locate's reason names the cited path back, so `refused` is page-derived too.
  "sources[].in_doubt[].citations[].refused",
  "sources[].in_doubt[].refused[].footnote",
  "sources[].in_doubt[].refused[].path",
  "sources[].in_doubt[].refused[].locator",
  "sources[].in_doubt[].refused[].refused",
  "sources[].repin[].page",
  "sources[].repin[].verified_at",
  "sources[].repin[].cited_at",
  "sources[].repin[].citations[].footnote",
  "sources[].repin[].citations[].path",
  "sources[].repin[].citations[].locator",
  "sources[].repin[].citations[].cited_at",
  "sources[].unresolvable[].revision",
  "sources[].unresolvable[].pages",
  "sources[].unresolvable[].cited_only",
  "sources[].unverifiable",
  "sources[].unpinned[].page",
  "sources[].unpinned[].footnote",
  "sources[].delegated.pending[].revision",
  "sources[].delegated.pending[].pages",
  "sources[].delegated.pending[].cited_only",
  "sources[].delegated.via",
  "unloaded_sources[].file",
  "unloaded_sources[].id",
  "unloaded_sources[].reason",
] as const;

/** With `--base`, `on_base` says the base branch already failed to load the same declaration. */
type UnloadedEntry = UncheckedSource & { on_base?: boolean };

/** Keys of what a base report had in doubt, could not place, left unchecked, or did not load. */
type BaseKeys = Set<string> & {
  unloaded?: Map<string, Pick<UncheckedSource, "id" | "pages">>;
};

// Citation and unplaced keys carry the revision, so one re-pinned since the base and broken again is new.
const citationKey = (source: string, page: string, c: DoubtedCitation) =>
  JSON.stringify(["cited", source, page, c.footnote, c.path, c.locator, c.cited_at]);
// Per file there is nothing to re-pin, and a page can move between its pin and its own revision.
const fileKey = (source: string, page: string) => JSON.stringify(["file", source, page]);
const unplacedKey = (source: string, page: string, revision: string) =>
  JSON.stringify(["unplaced", source, page, revision]);
// One key by page: a page gaining a revision, or re-verified at a new one, leaves no new work undone.
const uncheckedKeys = (
  source: string,
  s: { unverifiable?: string[]; delegated?: { pending: { pages: string[] }[] } | null },
) =>
  [...(s.unverifiable ?? []), ...(s.delegated?.pending ?? []).flatMap((e) => e.pages)].map((page) =>
    JSON.stringify(["unchecked", source, page]),
  );

export function readBase(path: string, only?: string): BaseKeys {
  let json: DriftJson;
  try {
    json = JSON.parse(readFileSync(path, "utf-8")) as DriftJson;
  } catch (error) {
    throw new Error(`--base ${path} is not a \`drift --json\` report: ${String(error)}`, {
      cause: error,
    });
  }
  if (!Array.isArray(json.sources)) {
    throw new Error(`--base ${path} is not a \`drift --json\` report: it has no sources.`);
  }
  // Every other source would read as newly in doubt.
  if (json.source !== undefined && json.source !== only) {
    throw new Error(
      `--base ${path} checked only source "${json.source}"; add --source ${json.source}.`,
    );
  }
  const unloaded: NonNullable<BaseKeys["unloaded"]> = new Map();
  const keys: BaseKeys = Object.assign(new Set<string>(), { unloaded });
  for (const source of json.sources) {
    for (const page of source.in_doubt ?? []) {
      if (page.citations === null) {
        keys.add(fileKey(source.source_id, page.page));
      } else {
        for (const c of page.citations) keys.add(citationKey(source.source_id, page.page, c));
      }
    }
    for (const entry of source.unresolvable ?? []) {
      for (const page of entry.pages) keys.add(unplacedKey(source.source_id, page, entry.revision));
    }
    for (const key of uncheckedKeys(source.source_id, source)) keys.add(key);
  }
  // Absent from reports written before unloaded sources were reported: then none is inherited.
  for (const u of json.unloaded_sources ?? []) {
    unloaded.set(u.file, { id: u.id, pages: u.pages ?? null });
  }
  return keys;
}

/**
 * Inherited by file, not reason, so a new error on the same declaration is not new; but not when
 * its id changed or more pages now cite it, since the change then hides more than the base did.
 */
function unloadedOnBase(u: UncheckedSource, base: BaseKeys): boolean {
  const was = base.unloaded?.get(u.file);
  if (!was || was.id !== u.id) return false;
  return u.pages === null ? was.pages === null : was.pages !== null && u.pages <= was.pages;
}

function markUnloaded(unloaded: UncheckedSource[], base?: BaseKeys): UnloadedEntry[] {
  return base ? unloaded.map((u) => ({ ...u, on_base: unloadedOnBase(u, base) })) : unloaded;
}

const isNew = (page: DoubtedPage) =>
  page.citations === null ? !page.on_base : page.citations.some((c) => !c.on_base);

/**
 * Only pages whose cited lines changed are named; untouched ones are counted, never listed.
 * `unloaded` comes marked against `base` by the caller; one unmarked counts as new.
 */
export function toJson(
  reports: DriftReport[],
  base?: BaseKeys,
  unloaded: UnloadedEntry[] = [],
): DriftJson {
  const sources = reports.map((report) => verdict(report, base));
  const doubted = sources.flatMap((source) => source.in_doubt);
  const unplaced = sources.flatMap((source) =>
    source.unresolvable.flatMap((e) =>
      e.pages.map((page) => ({ page, key: unplacedKey(source.source_id, page, e.revision) })),
    ),
  );
  return {
    pages_in_doubt: distinct(doubted.map((p) => p.page)),
    pages_newly_in_doubt: distinct(doubted.filter(isNew).map((p) => p.page)),
    pages_unplaceable: distinct(unplaced.map((u) => u.page)),
    pages_newly_unplaceable: distinct(unplaced.filter((u) => !base?.has(u.key)).map((u) => u.page)),
    sources,
    unloaded_sources: unloaded,
    sources_newly_unloaded: unloaded.filter((u) => !u.on_base).length,
    _provenance: provenance(DRIFT_FIELDS, DRIFT_NOTICE),
  };
}

function verdict(report: DriftReport, base?: BaseKeys): SourceVerdict {
  const inDoubt: DoubtedPage[] = [];
  const repin: RepinPage[] = [];
  let other = 0;
  const id = report.sourceId;

  for (const entry of report.stale) {
    const doubt = pageChanges(entry);
    for (const page of entry.pages) {
      const level = doubt ? doubt.get(page)! : null;
      const mine = (entry.citations ?? []).filter((c) => c.page === page);
      const at = entry.citedOnly?.includes(page)
        ? { cited_at: entry.revision }
        : { verified_at: entry.revision };
      if (level === null) {
        const refused = entry.refused?.[page];
        inDoubt.push({
          page,
          ...at,
          citations: null,
          ...(refused
            ? { refused }
            : { changed_paths: entry.citedPaths?.[page] ?? entry.changedPaths }),
          ...(base ? { on_base: base.has(fileKey(id, page)) } : {}),
        });
      } else if (level === "changed") {
        inDoubt.push({
          page,
          ...at,
          citations: mine.filter(isChanged).map((c) => {
            const cited: DoubtedCitation = {
              footnote: c.footnote,
              path: c.path,
              locator: c.locator,
              cited_at: c.revision,
              change: c.change.status as DoubtedCitation["change"],
              ...(c.refused === undefined ? {} : { refused: c.refused }),
            };
            if (base) cited.on_base = base.has(citationKey(id, page, cited));
            return cited;
          }),
        });
      } else if (level !== "moved") {
        other++;
      }
      // Also on a page in doubt: fixing only its changed citations would leave these locators stale.
      const moved = mine.flatMap(repinOf);
      if (moved.length > 0) repin.push({ page, ...at, citations: moved });
    }
  }

  return {
    source_id: id,
    current_revision: report.currentRevision,
    in_doubt: inDoubt.toSorted((a, b) => compare(a.page, b.page)),
    repin: repin.toSorted((a, b) => compare(a.page, b.page)),
    other_stale_pages: other,
    unresolvable: report.unresolvable.map(unplacedJson),
    unverifiable: report.unverifiable,
    unpinned: report.unpinned ?? [],
    delegated: report.delegated && {
      via: report.delegated.via,
      pending: report.delegated.pending.map(unplacedJson),
    },
  };
}

const repinOf = (c: CitedChange): RepinPage["citations"] =>
  c.change.status === "moved" && c.locator !== null
    ? [
        {
          footnote: c.footnote,
          path: c.path,
          locator: c.locator,
          cited_at: c.revision,
          now: c.change.locator,
        },
      ]
    : [];

const isChanged = (c: CitedChange) =>
  c.change.status === "touched" || c.change.status === "unknown";

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Characters for the whole comment body. GitHub refuses a comment over 65,536 and the action's
 * marker adds under 100, so this leaves a margin.
 */
export const GITHUB_BODY_LIMIT = 60_000;

/** A line of the comment. Rows are what the budget drops, lowest priority first; the rest stays. */
interface Line {
  text: string;
  /** 0 for rows new with this change, 1 for the rest. */
  row?: 0 | 1;
  /** A table: its header goes when every one of its rows was dropped. */
  group?: number;
}

/** Markdown for a pull request comment. Names only the pages whose cited lines changed. */
export function toGithub(
  reports: DriftReport[],
  base?: BaseKeys,
  limit = GITHUB_BODY_LIMIT,
  unloaded: UnloadedEntry[] = [],
): string {
  const json = toJson(reports, base, unloaded);
  const lines: Line[] = [{ text: "### accreta drift" }, { text: "" }];
  const text = (...values: string[]) => lines.push(...values.map((value) => ({ text: value })));
  const unloadedLine = (source: UnloadedEntry) =>
    `- ${code(source.file)} ${unchecked(source)}, so ${uncheckedPages(source.pages)}: ${code(source.reason)}`;
  const inherited = json.unloaded_sources.filter((u) => u.on_base);
  // Before the headline, so the counts-only fallback comment still carries them.
  for (const source of json.unloaded_sources) if (!source.on_base) text(unloadedLine(source));
  if (json.sources_newly_unloaded > 0) text("");
  let groups = 0;
  const table = (header: string[], values: string[], row: (index: number) => 0 | 1 = () => 1) => {
    const group = groups++;
    lines.push(...header.map((value) => ({ text: value, group })));
    lines.push(...values.map((value, i) => ({ text: value, row: row(i), group })));
  };
  const HEADER = ["", "| Page | Cited lines | Lines as of | Change |", "|---|---|---|---|"];

  if (json.sources.length === 0 && unloaded.length === 0) {
    text("No sources declared in `sources/`. Nothing to check.");
    return fit(lines, limit);
  }
  text(headline(json, base !== undefined));
  if (inherited.length > 0) {
    text(
      "",
      "<details>",
      `<summary>${inherited.length} source declaration(s) already ${uncheckedAll(inherited)} on the base branch.</summary>`,
      "",
      ...inherited.map(unloadedLine),
      "",
      "</details>",
    );
  }

  for (const source of json.sources) {
    text("");
    if (source.delegated) {
      const count = distinctPages(source.delegated.pending);
      text(
        `${code(source.source_id)} is read by the agent through ${code(source.delegated.via)}, ` +
          `not by accreta: ${count} page(s) to re-verify there.`,
      );
      continue;
    }

    const quiet =
      source.in_doubt.length +
        source.repin.length +
        source.unresolvable.length +
        source.unverifiable.length ===
        0 && source.other_stale_pages === 0;
    const at = `${code(source.source_id)} at ${code(source.current_revision ?? "")}`;
    text(
      quiet
        ? `${at}: up to date.`
        : `${at}. Re-pin after merge: a merge or squash commit gets a new SHA.`,
    );

    const fresh = source.in_doubt.flatMap((page) => doubtRows(page, false));
    const known = source.in_doubt.flatMap((page) => doubtRows(page, true));
    if (fresh.length > 0) table(HEADER, fresh, () => 0);
    if (known.length > 0) {
      const count = distinct(
        source.in_doubt.filter((page) => doubtRows(page, true).length > 0).map((p) => p.page),
      );
      text(
        "",
        "<details>",
        `<summary>${count} page(s) were already in doubt on the base branch.</summary>`,
      );
      table(HEADER, known);
      text("", "</details>");
    }

    if (source.repin.length > 0) {
      text(
        "",
        "<details>",
        `<summary>${source.repin.flatMap((p) => p.citations).length} citation(s) to re-pin on ${distinct(source.repin.map((p) => p.page))} page(s): the cited lines moved, unchanged.</summary>`,
      );
      table(
        ["", "| Page | Cited lines | Lines as of | Now at |", "|---|---|---|---|"],
        source.repin.flatMap((page) =>
          page.citations.map(
            (c) =>
              `| ${cellCode(page.page)} | ${cellCode(`${c.path}#${c.locator}`)}${footnote(c.footnote)} ` +
              `| ${cellCode(c.cited_at)} | ${cellCode(c.now)} |`,
          ),
        ),
      );
      text("", "</details>");
    }

    if (source.other_stale_pages > 0) {
      text(
        "",
        `${source.other_stale_pages} other page(s) rest on this source, ` +
          "but none of the lines they cite changed.",
      );
    }
    if (source.unresolvable.length > 0) {
      const count = distinctPages(source.unresolvable);
      text(
        "",
        "<details>",
        `<summary>${count} page(s) rest on a revision this source cannot place.</summary>`,
        "",
        "A shallow clone does this: check out with `fetch-depth: 0`.",
      );
      const unplaced = source.unresolvable.flatMap((e) =>
        e.pages.map((page) => ({
          page,
          revision: e.revision,
          at: atLabel({ citedOnly: e.cited_only }, page),
        })),
      );
      table(
        [""],
        unplaced.map((u) => `- ${code(u.page)}, ${u.at} ${code(u.revision)}`),
        (i) =>
          base?.has(unplacedKey(source.source_id, unplaced[i]!.page, unplaced[i]!.revision))
            ? 1
            : 0,
      );
      text("", "</details>");
    }
    const { none, pinless } = unverifiedApart(source.unverifiable, source.unpinned);
    if (none.length > 0) text("", `${none.length} page(s) record no revision at all.`);
    if (pinless > 0) {
      text("", `${pinless} page(s) cite this source without a revision:`);
      table(
        [""],
        source.unpinned.map((u) => {
          const { cited, fix } = howToPin(u);
          return `- ${code(u.page)} ${code(cited)} names no revision: ${fix}.`;
        }),
      );
    }
  }
  return fit(lines, limit);
}

/** A source whose revision failed did load; what failed is the check. */
const unchecked = (u: UnloadedEntry) => (u.unreadable ? "could not be checked" : "did not load");
const uncheckedAll = (us: readonly UnloadedEntry[]) =>
  us.some((u) => u.unreadable)
    ? us.every((u) => u.unreadable)
      ? "could not be checked"
      : "did not load or could not be checked"
    : "did not load";

function headline(json: DriftJson, compared: boolean): string {
  const n = json.sources_newly_unloaded;
  const kept = json.unloaded_sources.length - n;
  const fresh = json.unloaded_sources.filter((u) => !u.on_base);
  const still = json.unloaded_sources.filter((u) => u.on_base).every((u) => !u.unreadable)
    ? "still do not load"
    : "still cannot be loaded or checked";
  const cause = compared ? " because of this change" : "";
  // In the headline so the counts-only fallback keeps it, though it does not count as new.
  const clauses = [
    n > 0
      ? `**${n} source declaration(s) ${uncheckedAll(fresh)}${cause}; pages citing them were not checked.**`
      : "",
    kept > 0
      ? `**${kept} source declaration(s) ${still}, as on the base branch; pages citing them were not checked.**`
      : "",
  ];
  return [...clauses.filter(Boolean), pagesHeadline(json, compared)].join(" ");
}

function pagesHeadline(json: DriftJson, compared: boolean): string {
  const n = compared ? json.pages_newly_in_doubt : json.pages_in_doubt;
  const plural = n === 1 ? "page" : "pages";
  if (n > 0) {
    return compared
      ? `**${n} ${plural} newly in doubt:** this change touched lines ${n === 1 ? "it cites" : "they cite"}.`
      : `**${n} ${plural} in doubt:** lines ${n === 1 ? "it cites" : "they cite"} have changed.`;
  }
  if (json.pages_unplaceable > 0) {
    return "**No cited line is known to have changed,** but some revisions cannot be placed.";
  }
  if (compared && json.pages_in_doubt > 0) {
    return `**No page newly in doubt.** ${json.pages_in_doubt} page(s) were already in doubt on the base branch.`;
  }
  const pages = json.unloaded_sources.length > 0 ? "any checked page" : "any page";
  return compared
    ? `**No page newly in doubt.** No line ${pages} cites has changed.`
    : `**No page in doubt.** No line ${pages} cites has changed.`;
}

/** Rows of one page, split by whether the base branch already had them in doubt. */
function doubtRows(page: DoubtedPage, onBase: boolean): string[] {
  if (page.citations === null) {
    if ((page.on_base ?? false) !== onBase) return [];
    const at = cellCode((page.verified_at ?? page.cited_at)!);
    if (page.refused) {
      return page.refused.map(
        (c) => `| ${cellCode(page.page)} | ${cited(c)} | ${at} | ${refusedCell(c.refused)} |`,
      );
    }
    const paths = page.changed_paths ?? [];
    const shown = paths.slice(0, 5).map(cellCode);
    if (paths.length > 5) shown.push(`and ${paths.length - 5} more`);
    // A page of the source rests on all of it; one that only cites it, on the files it cites.
    const files = page.cited_at === undefined ? `any of ${shown.join(", ")}` : shown.join(", ");
    return [
      `| ${cellCode(page.page)} | ${files} | ${at} | file changed; this source cannot tell lines |`,
    ];
  }
  return page.citations
    .filter((c) => (c.on_base ?? false) === onBase)
    .map((c) => {
      const change =
        c.refused !== undefined
          ? refusedCell(c.refused)
          : c.change === "touched"
            ? "changed"
            : "unknown: re-read it";
      return `| ${cellCode(page.page)} | ${cited(c)} | ${cellCode(c.cited_at)} | ${change} |`;
    });
}

const footnote = (id: string | null) => (id === null ? "" : ` ${cellCode(`[^${id}]`)}`);

const cited = (c: { path: string; locator: string | null; footnote: string | null }) =>
  `${cellCode(c.locator === null ? c.path : `${c.path}#${c.locator}`)}${footnote(c.footnote)}`;

const refusedCell = (why: string) => `refused: ${cellCode(why)}`;

/** Keep the rows that fit the budget, newly-in-doubt ones first, each kind in order, and count the rest. */
function fit(lines: Line[], limit: number): string {
  const fixed = lines
    .filter((line) => line.row === undefined)
    .reduce((n, line) => n + line.text.length + 1, 0);
  let room = limit - fixed - moreRows(lines.length).length - 2;
  const kept = new Set<Line>();
  for (const priority of [0, 1]) {
    for (const line of lines) {
      if (line.row !== priority) continue;
      if (line.text.length + 1 > room) break;
      kept.add(line);
      room -= line.text.length + 1;
    }
  }
  const shownGroups = new Set([...kept].map((line) => line.group));
  const out = lines
    .filter((line) =>
      line.row === undefined
        ? line.group === undefined || shownGroups.has(line.group)
        : kept.has(line),
    )
    .map((line) => line.text);
  const omitted = lines.filter((line) => line.row !== undefined).length - kept.size;
  if (omitted > 0) out.push("", moreRows(omitted));
  return out.join("\n");
}

const moreRows = (count: number) =>
  `…and ${count} more rows. Run \`accreta drift --json\` for all of them.`;

/** A code span that holds any value: nothing in it renders as Markdown or HTML. */
function code(value: string): string {
  const flat = printable(value.replaceAll(/\s+/g, " "));
  if (flat === "") return "` `";
  const longest = Math.max(0, ...[...flat.matchAll(/`+/g)].map((match) => match[0].length));
  const fence = "`".repeat(longest + 1);
  const pad = flat.startsWith("`") || flat.endsWith("`") ? " " : "";
  return `${fence}${pad}${flat}${pad}${fence}`;
}

/** A code span inside a table cell, where a pipe would end the cell even in code. */
const cellCode = (value: string) => code(value).replaceAll("|", "\\|");
