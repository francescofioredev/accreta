import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, isAbsolute } from "node:path";
import { footnoteKey } from "../citations.ts";
import type { AccretaConfig } from "../config.ts";
import type { Database } from "../index-db/db.ts";
import { UNPINNED_REVISION } from "../source/adapter.ts";
import { getPage } from "./page.ts";

export type VerdictValue = "supported" | "unsupported";

/** One line of the verdict file. `writer` is filled by the tool, `model` is declared by the caller. */
export interface VerdictLine {
  page: string;
  footnote: string;
  /** `source:path#locator`, the citation text without the revision. */
  citation: string;
  revision: string;
  /** Hash of the citing sentence: an edit to it voids the verdict. */
  sentence: string;
  verdict: VerdictValue;
  writer: string;
  model: string;
  date: string;
}

/** A readable citation with the key a verdict is stored under. */
export interface KeyedCitation {
  pagePath: string;
  footnote: string;
  line: number;
  claim: string;
  source: string;
  path: string;
  locator: string;
  /** The pinned revision, or the page's `last_verified_revision` when the footnote names none. */
  revision: string;
  key: string;
}

export const DEFAULT_VERDICT_FILE = "verdicts.jsonl";

/** Where the verdict file lives: `provenance.verdict_file`, else beside the pages. */
export function verdictPathFor(root: string, config: AccretaConfig): string {
  return join(root, config.verdictFile ?? join(config.knowledgeBase, DEFAULT_VERDICT_FILE));
}

export function sentenceHash(claim: string): string {
  const flat = claim.normalize("NFC").replace(/\s+/g, " ").trim();
  return createHash("sha256").update(flat).digest("hex").slice(0, 16);
}

export function verdictKey(parts: {
  page: string;
  footnote: string;
  citation: string;
  revision: string;
  sentence: string;
}): string {
  return [
    parts.page,
    footnoteKey(parts.footnote),
    parts.citation,
    parts.revision,
    parts.sentence,
  ].join("\0");
}

const lineKey = (line: VerdictLine) => verdictKey(line);

interface CitationRow {
  page_path: string;
  footnote: string;
  line: number;
  claim: string;
  source: string | null;
  revision: string | null;
  path: string | null;
  locator: string | null;
  page_source: string | null;
  last_verified_revision: string | null;
}

/**
 * Every footnote whose citation has a source, path and locator and a revision to pin the
 * verdict to, keyed as the verdict file keys it. A footnote id defined twice has no one key.
 */
export function keyedCitations(db: Database): KeyedCitation[] {
  const rows = db
    .prepare(
      `SELECT c.page_path, c.footnote, c.line, c.claim, c.source, c.revision, c.path, c.locator,
              p.source AS page_source, p.last_verified_revision
       FROM citations c LEFT JOIN pages p ON p.path = c.page_path
       ORDER BY c.page_path, c.line`,
    )
    .all() as CitationRow[];
  const count = new Map<string, number>();
  for (const r of rows) {
    const id = `${r.page_path}\0${footnoteKey(r.footnote)}`;
    count.set(id, (count.get(id) ?? 0) + 1);
  }
  const out: KeyedCitation[] = [];
  for (const r of rows) {
    if (r.source === null || r.path === null || r.locator === null) continue;
    if ((count.get(`${r.page_path}\0${footnoteKey(r.footnote)}`) ?? 0) > 1) continue;
    if (r.revision === UNPINNED_REVISION) continue;
    const pinned = r.revision !== null && r.revision !== "";
    const revision = pinned
      ? (r.revision as string)
      : r.source === r.page_source && r.last_verified_revision
        ? r.last_verified_revision
        : "";
    if (revision === "") continue;
    const citation = `${r.source}:${r.path}#${r.locator}`;
    out.push({
      pagePath: r.page_path,
      footnote: r.footnote,
      line: r.line,
      claim: r.claim,
      source: r.source,
      path: r.path,
      locator: r.locator,
      revision,
      key: verdictKey({
        page: r.page_path,
        footnote: r.footnote,
        citation,
        revision,
        sentence: sentenceHash(r.claim),
      }),
    });
  }
  return out;
}

export interface VerdictFile {
  lines: VerdictLine[];
  /** Why the file was not read at all; lint says so rather than reporting nothing. */
  problem?: string;
  /** Lines that were not a verdict this build can read; they are ignored, not repaired. */
  unreadable: number;
}

const isString = (v: unknown): v is string => typeof v === "string";

export function parseVerdicts(text: string): VerdictFile {
  const lines: VerdictLine[] = [];
  let unreadable = 0;
  for (const raw of text.split(/\r?\n/)) {
    if (raw.trim() === "") continue;
    try {
      const v = JSON.parse(raw) as Record<string, unknown>;
      if (
        v &&
        typeof v === "object" &&
        isString(v.page) &&
        isString(v.footnote) &&
        isString(v.citation) &&
        isString(v.revision) &&
        isString(v.sentence) &&
        (v.verdict === "supported" || v.verdict === "unsupported") &&
        isString(v.writer) &&
        isString(v.model) &&
        isString(v.date)
      ) {
        lines.push(v as unknown as VerdictLine);
        continue;
      }
    } catch {
      // counted below
    }
    unreadable++;
  }
  return { lines, unreadable };
}

function lstatExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/** Why the verdict file cannot be used: a path that leaves the root through a symlink, or a file that is not one. */
export function verdictFileProblem(root: string, config: AccretaConfig): string | undefined {
  const path = verdictPathFor(root, config);
  try {
    if (lstatExists(path)) {
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) return "the verdict file is a symlink";
      if (!stat.isFile()) return "the verdict file is not a regular file";
    }
    let dir = dirname(path);
    while (!existsSync(dir)) dir = dirname(dir);
    const inside = relative(realpathSync(root), realpathSync(dir));
    if (inside.startsWith("..") || isAbsolute(inside)) {
      return "the verdict file's directory resolves outside the knowledge base's root";
    }
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return undefined;
}

export function readVerdictFile(root: string, config: AccretaConfig): VerdictFile {
  const path = verdictPathFor(root, config);
  const problem = verdictFileProblem(root, config);
  if (problem !== undefined) return { lines: [], unreadable: 0, problem };
  if (!existsSync(path)) return { lines: [], unreadable: 0 };
  return parseVerdicts(readFileSync(path, "utf-8"));
}

/** The verdict that holds for each key now; a later line replaces an earlier one. */
export function currentVerdicts(file: VerdictFile): Map<string, VerdictLine> {
  const map = new Map<string, VerdictLine>();
  for (const line of file.lines) map.set(lineKey(line), line);
  return map;
}

// The file is edited by hand and by agents: nothing in it may rewrite a terminal or a finding.
const clean = (value: string, max = 80) =>
  [...value.replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, "?")].slice(0, max).join("");

export function describeVerdict(line: VerdictLine): string {
  return `${line.verdict} by ${clean(line.writer)}, model ${clean(line.model)} (declared), ${clean(line.date, 10)}`;
}

export interface VerdictPlan {
  ok: true;
  line: VerdictLine;
  citation: KeyedCitation;
}

export type VerdictRefusal = { ok: false; message: string };

/** Resolve a page and footnote to the key a verdict would be stored under, or say why not. */
export function planVerdict(
  db: Database,
  config: AccretaConfig,
  input: {
    page: string;
    footnote: string;
    verdict: string;
    model: string;
    writer: string;
    date: string;
  },
): VerdictPlan | VerdictRefusal {
  if (input.verdict !== "supported" && input.verdict !== "unsupported") {
    return { ok: false, message: 'A verdict is "supported" or "unsupported".' };
  }
  const model = input.model.trim();
  if (!model || /[\p{Cc}\p{Zl}\p{Zp}]/u.test(model) || [...model].length > 80) {
    return {
      ok: false,
      message: "Declare the model as one line of at most 80 characters (use `human` if you are).",
    };
  }
  const page = getPage(db, input.page, config);
  if (!page) return { ok: false, message: `No page matches "${input.page}".` };
  const id = footnoteKey(input.footnote.replace(/^\[?\^/, "").replace(/\]$/, ""));
  const all = keyedCitations(db).filter(
    (c) => c.pagePath === page.path && footnoteKey(c.footnote) === id,
  );
  if (all.length === 0) {
    const rows = db
      .prepare(`SELECT footnote FROM citations WHERE page_path = ?`)
      .all(page.path) as { footnote: string }[];
    if (rows.filter((r) => footnoteKey(r.footnote) === id).length > 1) {
      return {
        ok: false,
        message: `${input.page} defines that footnote more than once; fix the duplicate (lint lists it) before recording a verdict.`,
      };
    }
    return {
      ok: false,
      message: `${input.page} has no footnote [^${input.footnote.replace(/^\[?\^/, "").replace(/\]$/, "")}] with a source, path, locator and revision to pin a verdict to (a page's \`last_verified_revision\` stands in only when the footnote format has no {rev}, and only for the page's own source). Run \`accreta reindex\` if the page changed.`,
    };
  }
  const citation = all[0]!;
  return {
    ok: true,
    citation,
    line: {
      page: page.path,
      footnote: citation.footnote,
      citation: `${citation.source}:${citation.path}#${citation.locator}`,
      revision: citation.revision,
      sentence: sentenceHash(citation.claim),
      verdict: input.verdict,
      writer: input.writer,
      model,
      date: input.date,
    },
  };
}

/** Append a verdict, dropping older lines for the same footnote: one current key, so the rest are voided. */
export function writeVerdict(root: string, config: AccretaConfig, line: VerdictLine): string {
  const path = verdictPathFor(root, config);
  const problem = verdictFileProblem(root, config);
  if (problem !== undefined) throw new Error(problem);
  if (existsSync(path)) {
    const held = parseVerdicts(readFileSync(path, "utf-8"));
    if (held.lines.length === 0 && held.unreadable > 0) {
      throw new Error("the verdict file holds no verdict this build can read; it is left alone");
    }
  }
  const kept = existsSync(path)
    ? readFileSync(path, "utf-8")
        .split(/\r?\n/)
        .filter((raw) => {
          if (raw.trim() === "") return false;
          try {
            const v = JSON.parse(raw) as Partial<VerdictLine>;
            return !(
              v.page === line.page && footnoteKey(v.footnote ?? "") === footnoteKey(line.footnote)
            );
          } catch {
            return true;
          }
        })
    : [];
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, [...kept, JSON.stringify(line)].join("\n") + "\n", "utf-8");
  renameSync(tmp, path);
  return path;
}

/** Band 3: advisory findings for recorded "unsupported", and the footnotes a "supported" silences. */
export function verdictFindings(
  db: Database,
  file: VerdictFile,
): {
  findings: { kind: "citation-unsupported"; path: string; detail: string }[];
  supported: Set<string>;
} {
  const held = currentVerdicts(file);
  const findings: { kind: "citation-unsupported"; path: string; detail: string }[] = [];
  const supported = new Set<string>();
  if (held.size === 0) return { findings, supported };
  for (const c of keyedCitations(db)) {
    const v = held.get(c.key);
    if (!v) continue;
    if (v.verdict === "supported") supported.add(`${c.pagePath}\0${footnoteKey(c.footnote)}`);
    else {
      findings.push({
        kind: "citation-unsupported",
        path: c.pagePath,
        detail: `[^${c.footnote}] (line ${c.line}): recorded ${describeVerdict(v)}; ${c.path}#${c.locator} at ${c.revision} does not back the sentence`,
      });
    }
  }
  return { findings, supported };
}
