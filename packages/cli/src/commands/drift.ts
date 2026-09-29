import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  detectDrift,
  openIndex,
  pageChanges,
  type CitedChange,
  type DriftReport,
  type PageChange,
  type StaleRevision,
  type UnresolvableRevision,
} from "@accreta/core";
import { countUnchecked, uncheckedPages, type UncheckedSource } from "@accreta/adapters";
import { findWorkspace } from "../workspace.ts";
import { loadSources, type CommandContext } from "./shared.ts";

export type DriftFormat = "text" | "json" | "github";

export interface DriftOptions {
  format: DriftFormat;
  /** A `drift --json` report from the base branch, to tell what this change put in doubt. */
  base?: string;
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
    base = options.base ? readBase(resolve(ctx.cwd, options.base)) : undefined;
  } catch (error) {
    // 2, as for any refused argument: 1 already means drift found something.
    ctx.err(error instanceof Error ? error.message : String(error));
    return 2;
  }

  const loaded = loadSources(workspace);
  const reports: DriftReport[] = [];
  let unloaded: UncheckedSource[] = [];
  if (loaded.sources.length > 0 || loaded.unloaded.length > 0) {
    const db = openIndex(workspace.indexPath, { readonly: true });
    try {
      for (const adapter of loaded.sources) reports.push(await detectDrift(db, adapter));
      unloaded = countUnchecked(db, loaded.unloaded);
    } finally {
      db.close();
    }
  }

  if (options.format === "json") {
    ctx.out(JSON.stringify(toJson(reports, base, unloaded), null, 2));
  } else if (options.format === "github") {
    ctx.out(toGithub(reports, base, GITHUB_BODY_LIMIT, unloaded));
  } else {
    for (const source of unloaded) {
      ctx.out(`${source.file} — did not load, so ${uncheckedPages(source.pages)}`);
      ctx.out(`  ${source.reason}`);
    }
    if (reports.length === 0 && unloaded.length === 0) {
      ctx.out("No sources declared in sources/. Nothing to check.");
    } else for (const report of reports) printText(ctx, report);
  }

  // "I cannot tell", like `unresolvable`: a typo in `type` must not turn a failing run green.
  const failed = reports.some((report) => fails(report, strict)) || unloaded.length > 0;
  return failed ? 1 : 0;
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

export function printText(ctx: Pick<CommandContext, "out">, report: DriftReport): void {
  // A source only the agent can reach produces a work order rather than a
  // verdict, so it is printed on its own terms and skips the outcomes below
  // — every one of which would imply somebody had looked.
  if (report.delegated) {
    const work = report.delegated;
    const pageCount = distinctPages(work.pending);
    ctx.out(`${report.sourceId} — read through ${work.via} by the agent, not by accreta`);

    if (pageCount > 0) {
      ctx.out(`  ${pageCount} page(s) for the agent to re-verify there:`);
      for (const entry of work.pending) {
        for (const path of entry.pages) {
          ctx.out(`    ${path} (${atLabel(entry, path)} ${entry.revision})`);
        }
      }
    } else {
      ctx.out("  no pages cite it yet");
    }
    if (report.unverifiable.length > 0) {
      ctx.out(`  ${report.unverifiable.length} page(s) record no revision at all`);
    }
    ctx.out("  in scope:");
    for (const line of work.guidance.trim().split("\n")) ctx.out(`    ${line}`);
    return;
  }

  ctx.out(`${report.sourceId} @ ${report.currentRevision}`);

  if (report.stale.length > 0) {
    // Not `report.stale.length`, which counts revisions; and each page once, as pins can split it.
    const pageCount = distinctPages(report.stale);
    ctx.out(`  ${pageCount} page(s) may have drifted:`);
    for (const entry of report.stale) {
      const doubt = pageChanges(entry);
      const pages = doubt
        ? entry.pages.toSorted(
            (a, b) => DOUBT_ORDER.indexOf(doubt.get(a)!) - DOUBT_ORDER.indexOf(doubt.get(b)!),
          )
        : entry.pages;
      for (const path of pages) {
        const why = doubt ? ` — ${explainDoubt(doubt.get(path)!, entry, path)}` : "";
        ctx.out(`    ${path} (${atLabel(entry, path)} ${entry.revision})${why}`);
      }
    }
  }
  // Reported separately because "I cannot tell" is not "out of date", and
  // collapsing them would misrepresent what the system actually knows.
  if (report.unresolvable.length > 0) {
    ctx.out(`  ${report.unresolvable.length} revision(s) this source cannot place:`);
    for (const entry of report.unresolvable) {
      ctx.out(`    ${entry.revision} — ${entry.pages.length} page(s)`);
    }
  }
  if (report.unverifiable.length > 0) {
    ctx.out(`  ${report.unverifiable.length} page(s) record no revision at all`);
  }
  if (report.stale.length === 0 && report.unresolvable.length === 0) {
    ctx.out("  up to date");
  }
}

const DOUBT_ORDER: PageChange[] = ["changed", "moved", "untouched", "uncited"];

function explainDoubt(doubt: PageChange, entry: StaleRevision, page: string): string {
  const mine = (entry.citations ?? []).filter((c) => c.page === page);
  const count = (status: string) => mine.filter((c) => c.change.status === status).length;
  switch (doubt) {
    case "changed":
      return `${count("touched") + count("unknown")} cited range(s) changed`;
    case "moved":
      return `cited lines moved, not changed: re-pin ${count("moved")} locator(s)`;
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
  /** With `--base`: the base branch already had this citation in doubt. */
  on_base?: boolean;
}

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
  repin: RepinPage[];
  /** Pages on a stale revision whose cited lines are untouched: lower in doubt, not verified. */
  other_stale_pages: number;
  unresolvable: UnresolvableRevision[];
  unverifiable: string[];
  delegated: { via: string; pending: UnresolvableRevision[] } | null;
}

interface DriftJson {
  pages_in_doubt: number;
  /** Pages with a citation in doubt that the base report did not have; all of them without one. */
  pages_newly_in_doubt: number;
  pages_unplaceable: number;
  /** Unplaceable pages the base report did not have at the same revision; all of them without one. */
  pages_newly_unplaceable: number;
  sources: SourceVerdict[];
  /** Declarations that did not build; nothing citing them was checked. */
  unloaded_sources: UncheckedSource[];
}

/** Keys of what a base report already had in doubt or could not place. */
type BaseKeys = Set<string>;

// The revision is part of each key, so a citation re-pinned since the base and broken again is new.
const citationKey = (source: string, page: string, c: DoubtedCitation) =>
  JSON.stringify(["cited", source, page, c.footnote, c.path, c.locator, c.cited_at]);
const fileKey = (source: string, page: string, verifiedAt: string) =>
  JSON.stringify(["file", source, page, verifiedAt]);
const unplacedKey = (source: string, page: string, revision: string) =>
  JSON.stringify(["unplaced", source, page, revision]);

function readBase(path: string): BaseKeys {
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
  const keys: BaseKeys = new Set();
  for (const source of json.sources) {
    for (const page of source.in_doubt ?? []) {
      if (page.citations === null) {
        keys.add(fileKey(source.source_id, page.page, (page.verified_at ?? page.cited_at)!));
      } else {
        for (const c of page.citations) keys.add(citationKey(source.source_id, page.page, c));
      }
    }
    for (const entry of source.unresolvable ?? []) {
      for (const page of entry.pages) keys.add(unplacedKey(source.source_id, page, entry.revision));
    }
  }
  return keys;
}

const isNew = (page: DoubtedPage) =>
  page.citations === null ? !page.on_base : page.citations.some((c) => !c.on_base);

/** Only pages whose cited lines changed are named; untouched ones are counted, never listed. */
export function toJson(
  reports: DriftReport[],
  base?: BaseKeys,
  unloaded: UncheckedSource[] = [],
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
        inDoubt.push({
          page,
          ...at,
          citations: null,
          changed_paths: entry.citedPaths?.[page] ?? entry.changedPaths,
          ...(base ? { on_base: base.has(fileKey(id, page, entry.revision)) } : {}),
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
            };
            if (base) cited.on_base = base.has(citationKey(id, page, cited));
            return cited;
          }),
        });
      } else if (level === "moved") {
        repin.push({
          page,
          ...at,
          citations: mine.flatMap((c) =>
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
              : [],
          ),
        });
      } else {
        other++;
      }
    }
  }

  return {
    source_id: id,
    current_revision: report.currentRevision,
    in_doubt: inDoubt.toSorted((a, b) => compare(a.page, b.page)),
    repin: repin.toSorted((a, b) => compare(a.page, b.page)),
    other_stale_pages: other,
    unresolvable: report.unresolvable,
    unverifiable: report.unverifiable,
    delegated: report.delegated && { via: report.delegated.via, pending: report.delegated.pending },
  };
}

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
  unloaded: UncheckedSource[] = [],
): string {
  const json = toJson(reports, base, unloaded);
  const lines: Line[] = [{ text: "### accreta drift" }, { text: "" }];
  const text = (...values: string[]) => lines.push(...values.map((value) => ({ text: value })));
  // Before the headline, so the counts-only fallback comment still carries them.
  for (const source of unloaded) {
    text(
      `- ${code(source.file)} did not load, so ${uncheckedPages(source.pages)}: ${code(source.reason)}`,
    );
  }
  if (unloaded.length > 0) text("");
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
        `<summary>${distinct(source.repin.map((p) => p.page))} page(s) only need re-pinning: the cited lines moved, unchanged.</summary>`,
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
        e.pages.map((page) => ({ page, revision: e.revision, at: atLabel(e, page) })),
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
    if (source.unverifiable.length > 0) {
      text("", `${source.unverifiable.length} page(s) record no revision at all.`);
    }
  }
  return fit(lines, limit);
}

function headline(json: DriftJson, compared: boolean): string {
  const n = json.unloaded_sources.length;
  if (n === 0) return pagesHeadline(json, compared);
  return (
    `**${n} source declaration(s) did not load; pages citing them were not checked.** ` +
    pagesHeadline(json, compared)
  );
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
    const paths = page.changed_paths ?? [];
    const shown = paths.slice(0, 5).map(cellCode);
    if (paths.length > 5) shown.push(`and ${paths.length - 5} more`);
    // A page of the source rests on all of it; one that only cites it, on the files it cites.
    const files = page.cited_at === undefined ? `any of ${shown.join(", ")}` : shown.join(", ");
    return [
      `| ${cellCode(page.page)} | ${files} | ${cellCode((page.verified_at ?? page.cited_at)!)} | file changed; this source cannot tell lines |`,
    ];
  }
  return page.citations
    .filter((c) => (c.on_base ?? false) === onBase)
    .map(
      (c) =>
        `| ${cellCode(page.page)} | ${cellCode(c.locator === null ? c.path : `${c.path}#${c.locator}`)}${footnote(c.footnote)} ` +
        `| ${cellCode(c.cited_at)} | ${c.change === "touched" ? "changed" : "unknown: re-read it"} |`,
    );
}

const footnote = (id: string | null) => (id === null ? "" : ` ${cellCode(`[^${id}]`)}`);

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
  const flat = value.replaceAll(/\s+/g, " ");
  if (flat === "") return "` `";
  const longest = Math.max(0, ...[...flat.matchAll(/`+/g)].map((match) => match[0].length));
  const fence = "`".repeat(longest + 1);
  const pad = flat.startsWith("`") || flat.endsWith("`") ? " " : "";
  return `${fence}${pad}${flat}${pad}${fence}`;
}

/** A code span inside a table cell, where a pipe would end the cell even in code. */
const cellCode = (value: string) => code(value).replaceAll("|", "\\|");
