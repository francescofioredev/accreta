import { parseLineLocator, UNPINNED_REVISION } from "@accreta/core";
import type { FootnoteRow, PageRow } from "./accreta.ts";
import { git, GitError, revParse, showAt } from "./git.ts";
import type { DeclaredSource } from "./sources.ts";

/** What the change did to a cited block: only `changed` is a drift positive. */
export type TruthStatus = "changed" | "moved" | "untouched";

/** Why a citation is left out of the score; protocol.md pre-registers these. */
export type Exclusion =
  | "not a citation"
  | "not a git source"
  | "unpinned"
  | "revision unknown"
  | "not a line range"
  | "path missing at its revision"
  | "range outside the file"
  | "ambiguous at its revision"
  | "ambiguous: block found more than once";

export interface CitationTruth {
  page: string;
  footnote: string;
  source: string;
  path: string;
  locator: string | null;
  /** The revision the locator's lines belong to, as the citation wrote it. */
  revision: string | null;
  status: TruthStatus | null;
  excluded: Exclusion | null;
  /** Where the block is at the target, when it survived. */
  now?: { path: string; locator: string };
  /** The cited file changed at all: what the trivial baseline flags. */
  fileChanged?: boolean;
}

/** Each changed path between two revisions, to its new path; null when deleted. */
export function changes(root: string, from: string, to: string): Map<string, string | null> {
  const out = git(root, "diff", "-M", "--name-status", "-z", "--relative", from, to);
  const fields = out.split("\0").filter((f) => f !== "");
  const map = new Map<string, string | null>();
  for (let i = 0; i < fields.length;) {
    const status = fields[i++]!;
    if (status.startsWith("R") || status.startsWith("C")) {
      const [a, b] = [fields[i++]!, fields[i++]!];
      if (status.startsWith("R")) map.set(a, b);
    } else {
      const path = fields[i++]!;
      if (status !== "A") map.set(path, status === "D" ? null : path);
    }
  }
  return map;
}

/** 1-based start lines where `block` occurs as whole lines of `lines`. */
export function occurrences(lines: readonly string[], block: readonly string[]): number[] {
  const out: number[] = [];
  outer: for (let i = 0; i + block.length <= lines.length; i++) {
    for (let j = 0; j < block.length; j++) if (lines[i + j] !== block[j]) continue outer;
    out.push(i + 1);
  }
  return out;
}

const splitLines = (text: string) => text.replace(/\n$/, "").split("\n");

/** Truth for one block: found at the same place, found once elsewhere, or gone. */
export function judgeBlock(
  before: string,
  range: readonly [number, number],
  path: string,
  after: { path: string; text: string } | null,
): Pick<CitationTruth, "status" | "excluded" | "now"> {
  const old = splitLines(before);
  if (range[1] > old.length) return { status: null, excluded: "range outside the file" };
  const block = old.slice(range[0] - 1, range[1]);
  if (after === null) return { status: "changed", excluded: null };
  // An edited block with a twin left intact would read as moved.
  if (occurrences(old, block).length > 1) {
    return { status: null, excluded: "ambiguous at its revision" };
  }
  const found = occurrences(splitLines(after.text), block);
  if (after.path === path && found.includes(range[0])) {
    return { status: "untouched", excluded: null };
  }
  if (found.length === 0) return { status: "changed", excluded: null };
  if (found.length > 1) return { status: null, excluded: "ambiguous: block found more than once" };
  const start = found[0]!;
  const end = start + block.length - 1;
  const locator = start === end ? `L${start}` : `L${start}-L${end}`;
  return { status: "moved", excluded: null, now: { path: after.path, locator } };
}

/** A citation with no locator cites the whole file: any byte changed is a change. */
export function judgeWhole(
  before: string,
  path: string,
  after: { path: string; text: string } | null,
): Pick<CitationTruth, "status" | "excluded" | "now"> {
  if (after === null || after.text !== before) return { status: "changed", excluded: null };
  if (after.path === path) return { status: "untouched", excluded: null };
  const n = splitLines(before).length;
  return {
    status: "moved",
    excluded: null,
    now: { path: after.path, locator: n === 1 ? "L1" : `L1-L${n}` },
  };
}

/**
 * Ground truth for every footnote citation, judged from git alone: the cited block at its own
 * revision, looked for verbatim in the file at the source's HEAD, following renames.
 */
export function driftTruth(
  pages: readonly PageRow[],
  footnotes: readonly FootnoteRow[],
  sources: readonly DeclaredSource[],
): CitationTruth[] {
  const byId = new Map(sources.map((s) => [s.id, s]));
  const pageOf = new Map(pages.map((p) => [p.path, p]));
  const resolved = new Map<string, string | null>();
  const renamed = new Map<string, Map<string, string | null>>();

  const resolve = (root: string, rev: string) => {
    const key = `${root}\0${rev}`;
    if (!resolved.has(key)) {
      try {
        resolved.set(key, revParse(root, rev));
      } catch (error) {
        if (!(error instanceof GitError)) throw error;
        resolved.set(key, null);
      }
    }
    return resolved.get(key)!;
  };

  return footnotes.flatMap((row): CitationTruth[] => {
    const base = {
      page: row.page_path,
      footnote: row.footnote,
      source: row.source ?? "",
      path: row.path ?? "",
      locator: row.locator ?? null,
      revision: row.revision ?? null,
    };
    const skip = (excluded: Exclusion): CitationTruth => ({ ...base, status: null, excluded });
    if (row.source == null || row.path == null) return [skip("not a citation")];

    const source = byId.get(row.source);
    if (source?.type !== "git") return [skip("not a git source")];
    // A footnote without a pin borrows its page's revision, as drift does, but only on its own source.
    let revision = row.revision && row.revision !== UNPINNED_REVISION ? row.revision : null;
    if (revision === null && pageOf.get(row.page_path)?.source === row.source) {
      revision = pageOf.get(row.page_path)!.last_verified_revision ?? null;
    }
    if (!revision) return [skip("unpinned")];
    const from = resolve(source.root, revision);
    if (from === null) return [skip("revision unknown")];
    const to = resolve(source.root, "HEAD");
    if (to === null)
      throw new Error(`source "${source.id}": git cannot resolve HEAD in ${source.root}`);

    const before = showAt(source.root, from, row.path);
    if (before === null) return [skip("path missing at its revision")];
    const range = row.locator == null ? null : parseLineLocator(row.locator);
    if (row.locator != null && range === null) return [skip("not a line range")];

    const key = `${source.root}\0${from}`;
    if (!renamed.has(key)) renamed.set(key, changes(source.root, from, to));
    const moves = renamed.get(key)!;
    const target = moves.has(row.path) ? moves.get(row.path)! : row.path;
    const text = target === null ? null : showAt(source.root, to, target);
    const after = target === null || text === null ? null : { path: target, text };

    const judged =
      range === null
        ? judgeWhole(before, row.path, after)
        : judgeBlock(before, range, row.path, after);
    return [{ ...base, ...judged, fileChanged: moves.has(row.path) }];
  });
}
