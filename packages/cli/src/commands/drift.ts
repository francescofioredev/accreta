import { existsSync } from "node:fs";
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
import { findWorkspace } from "../workspace.ts";
import { loadSources, type CommandContext } from "./shared.ts";

export type DriftFormat = "text" | "json" | "github";

export interface DriftOptions {
  strict?: boolean;
  format?: DriftFormat;
}

/** Read the flags only `drift` takes, which the shared parser leaves positional. */
export function driftOptions(args: readonly string[], strict: boolean): DriftOptions {
  let format: DriftFormat = "text";
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--json") {
      format = "json";
    } else if (arg === "--format") {
      const value = args[++i];
      if (value !== "text" && value !== "json" && value !== "github") {
        throw new Error(`--format takes text, json or github, not "${value ?? ""}".`);
      }
      format = value;
    } else {
      throw new Error(`drift does not take "${arg}".`);
    }
  }
  return { strict, format };
}

export async function drift(ctx: CommandContext, options: DriftOptions = {}): Promise<number> {
  const format = options.format ?? "text";
  const workspace = findWorkspace(ctx.cwd);
  if (!existsSync(workspace.indexPath)) {
    throw new Error(`No index at ${workspace.indexPath}. Run \`accreta reindex\` first.`);
  }

  const sources = loadSources(workspace);
  const reports: DriftReport[] = [];
  if (sources.length > 0) {
    const db = openIndex(workspace.indexPath, { readonly: true });
    try {
      for (const adapter of sources) reports.push(await detectDrift(db, adapter));
    } finally {
      db.close();
    }
  }

  if (format === "json") ctx.out(JSON.stringify(toJson(reports), null, 2));
  else if (format === "github") ctx.out(toGithub(reports));
  else if (reports.length === 0) ctx.out("No sources declared in sources/. Nothing to check.");
  else for (const report of reports) printText(ctx, report);

  return reports.some((report) => fails(report, options.strict ?? false)) ? 1 : 0;
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

function printText(ctx: CommandContext, report: DriftReport): void {
  // A source only the agent can reach produces a work order rather than a
  // verdict, so it is printed on its own terms and skips the outcomes below
  // — every one of which would imply somebody had looked.
  if (report.delegated) {
    const work = report.delegated;
    const pageCount = work.pending.reduce((total, entry) => total + entry.pages.length, 0);
    ctx.out(`${report.sourceId} — read through ${work.via} by the agent, not by accreta`);

    if (pageCount > 0) {
      ctx.out(`  ${pageCount} page(s) for the agent to re-verify there:`);
      for (const entry of work.pending) {
        for (const path of entry.pages) {
          ctx.out(`    ${path} (verified at ${entry.revision})`);
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
    // Summed over the groups rather than taken from `report.stale.length`,
    // which counts revisions now that the report is grouped. The reader is
    // being told how many pages are in doubt.
    const pageCount = report.stale.reduce((total, entry) => total + entry.pages.length, 0);
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
        ctx.out(`    ${path} (verified at ${entry.revision})${why}`);
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
  verified_at: string;
  citations: DoubtedCitation[] | null;
  changed_paths?: string[];
}

interface DoubtedCitation {
  footnote: string | null;
  path: string;
  locator: string | null;
  /** The revision the locator's lines belong to. */
  cited_at: string;
  change: "touched" | "unknown";
}

interface RepinPage {
  page: string;
  verified_at: string;
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
  sources: SourceVerdict[];
}

/** Only pages whose cited lines changed are named; untouched ones are counted, never listed. */
function toJson(reports: DriftReport[]): DriftJson {
  const sources = reports.map(verdict);
  return {
    pages_in_doubt: sources.reduce((total, source) => total + source.in_doubt.length, 0),
    sources,
  };
}

function verdict(report: DriftReport): SourceVerdict {
  const inDoubt: DoubtedPage[] = [];
  const repin: RepinPage[] = [];
  let other = 0;

  for (const entry of report.stale) {
    const doubt = pageChanges(entry);
    for (const page of entry.pages) {
      const level = doubt ? doubt.get(page)! : null;
      const mine = (entry.citations ?? []).filter((c) => c.page === page);
      if (level === null) {
        inDoubt.push({
          page,
          verified_at: entry.revision,
          citations: null,
          changed_paths: entry.changedPaths,
        });
      } else if (level === "changed") {
        inDoubt.push({
          page,
          verified_at: entry.revision,
          citations: mine.filter(isChanged).map((c) => ({
            footnote: c.footnote,
            path: c.path,
            locator: c.locator,
            cited_at: c.revision,
            change: c.change.status as DoubtedCitation["change"],
          })),
        });
      } else if (level === "moved") {
        repin.push({
          page,
          verified_at: entry.revision,
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
    source_id: report.sourceId,
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

/** Rows per table; a GitHub comment is capped at 65,536 characters. */
const MAX_ROWS = 100;

/** Markdown for a pull request comment. Names only the pages whose cited lines changed. */
function toGithub(reports: DriftReport[]): string {
  const json = toJson(reports);
  const lines: string[] = ["### accreta drift", ""];

  if (json.sources.length === 0) {
    lines.push("No sources declared in `sources/`. Nothing to check.");
    return lines.join("\n");
  }

  const n = json.pages_in_doubt;
  const unplaced = json.sources.some((source) => source.unresolvable.length > 0);
  lines.push(
    n > 0
      ? `**${n} page${n === 1 ? "" : "s"} in doubt:** lines ${n === 1 ? "it cites" : "they cite"} have changed.`
      : unplaced
        ? "**No cited line is known to have changed,** but some revisions cannot be placed."
        : "**No page in doubt.** No line any page cites has changed.",
  );

  for (const source of json.sources) {
    lines.push("");
    if (source.delegated) {
      const count = source.delegated.pending.reduce((total, e) => total + e.pages.length, 0);
      lines.push(
        `\`${cell(source.source_id)}\` is read by the agent through ${cell(source.delegated.via)}, ` +
          `not by accreta: ${count} page(s) to re-verify there.`,
      );
      continue;
    }
    const quiet =
      source.in_doubt.length + source.repin.length + source.unresolvable.length === 0 &&
      source.other_stale_pages === 0;
    lines.push(
      `\`${cell(source.source_id)}\` at ${cell(source.current_revision ?? "")}${quiet ? ": up to date." : ""}`,
    );

    if (source.in_doubt.length > 0) {
      lines.push("", "| Page | Cited lines | Lines as of | Change |", "|---|---|---|---|");
      const rows = source.in_doubt.flatMap(doubtRows);
      lines.push(...rows.slice(0, MAX_ROWS));
      if (rows.length > MAX_ROWS) lines.push("", moreRows(rows.length - MAX_ROWS));
    }

    if (source.repin.length > 0) {
      const rows = source.repin.flatMap((page) =>
        page.citations.map(
          (c) =>
            `| \`${cell(page.page)}\` | \`${cell(c.path)}\` ${cell(c.locator)}${footnote(c.footnote)} ` +
            `| ${cell(c.cited_at)} | ${cell(c.now)} |`,
        ),
      );
      lines.push(
        "",
        "<details>",
        `<summary>${source.repin.length} page(s) only need re-pinning: the cited lines moved, unchanged.</summary>`,
        "",
        "| Page | Cited lines | Lines as of | Now at |",
        "|---|---|---|---|",
        ...rows.slice(0, MAX_ROWS),
      );
      if (rows.length > MAX_ROWS) lines.push("", moreRows(rows.length - MAX_ROWS));
      lines.push("", "</details>");
    }

    if (source.other_stale_pages > 0) {
      lines.push(
        "",
        `${source.other_stale_pages} other page(s) were verified before this change, ` +
          "but none of the lines they cite changed.",
      );
    }
    if (source.unresolvable.length > 0) {
      const count = source.unresolvable.reduce((total, e) => total + e.pages.length, 0);
      const revisions = source.unresolvable.map((e) => cell(e.revision)).join(", ");
      lines.push(
        "",
        `${count} page(s) were verified at a revision this source cannot place (${revisions}). ` +
          "A shallow clone does this: check out with `fetch-depth: 0`.",
      );
    }
    if (source.unverifiable.length > 0) {
      lines.push("", `${source.unverifiable.length} page(s) record no revision at all.`);
    }
  }
  return lines.join("\n");
}

function doubtRows(page: DoubtedPage): string[] {
  if (page.citations === null) {
    const paths = page.changed_paths ?? [];
    const shown = paths.slice(0, 5).map((p) => `\`${cell(p)}\``);
    if (paths.length > 5) shown.push(`and ${paths.length - 5} more`);
    return [
      `| \`${cell(page.page)}\` | any of ${shown.join(", ")} | ${cell(page.verified_at)} | file changed; this source cannot tell lines |`,
    ];
  }
  return page.citations.map(
    (c) =>
      `| \`${cell(page.page)}\` | \`${cell(c.path)}\` ${cell(c.locator ?? "whole file")}${footnote(c.footnote)} ` +
      `| ${cell(c.cited_at)} | ${c.change === "touched" ? "changed" : "unknown: re-read it"} |`,
  );
}

// In a code span, so GitHub does not read it as a footnote reference of the comment.
const footnote = (id: string | null) => (id === null ? "" : ` \`[^${cell(id)}]\``);

const moreRows = (count: number) =>
  `…and ${count} more row(s). Run \`accreta drift --json\` for all of them.`;

/** Keep a value inside its table cell and code span. */
function cell(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll("`", "'").replaceAll(/\s+/g, " ");
}
