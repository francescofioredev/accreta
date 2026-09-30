import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openIndex } from "@accreta/core";

export const EVAL_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
export const REPO = join(EVAL_DIR, "..", "..");
export const CLI = join(REPO, "packages", "cli", "src", "main.ts");

export interface CliRun {
  code: number;
  stdout: string;
  stderr: string;
}

/** The knowledge base under evaluation, with its index kept outside it so the harness never writes there. */
export interface Kb {
  root: string;
  indexPath: string;
}

export function kbAt(root: string, indexPath?: string): Kb {
  return {
    root: resolve(root),
    indexPath: indexPath ?? join(mkdtempSync(join(tmpdir(), "accreta-eval-")), "index.sqlite"),
  };
}

/** Run the real CLI as a user would: a new process, the knowledge base named by ACCRETA_ROOT. */
export function accreta(kb: Kb, ...args: string[]): CliRun {
  const env = { ...process.env, ACCRETA_ROOT: kb.root, ACCRETA_INDEX_PATH: kb.indexPath };
  const proc = Bun.spawnSync([process.execPath, CLI, ...args], { cwd: kb.root, env });
  return {
    code: proc.exitCode ?? -1,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  };
}

export function reindex(kb: Kb): void {
  const run = accreta(kb, "reindex");
  if (run.code !== 0) throw new Error(`accreta reindex failed: ${run.stderr || run.stdout}`);
}

/** Lint and drift exit 1 when they find something; only a crash or a refused argument is an error. */
export function accretaJson<T>(kb: Kb, ...args: string[]): T {
  const run = accreta(kb, ...args);
  if (run.code !== 0 && run.code !== 1) {
    throw new Error(`accreta ${args.join(" ")} exited ${run.code}: ${run.stderr || run.stdout}`);
  }
  try {
    return JSON.parse(run.stdout) as T;
  } catch {
    throw new Error(`accreta ${args.join(" ")} printed no JSON: ${run.stdout}${run.stderr}`);
  }
}

export interface PageRow {
  path: string;
  type: string;
  source: string | null;
  canonical_source: string | null;
  last_verified_revision: string | null;
  body: string;
}

export interface FootnoteRow {
  page_path: string;
  footnote: string;
  line: number;
  text: string;
  source: string | null;
  revision: string | null;
  path: string | null;
  locator: string | null;
}

/** Pages and footnote citations as the indexer read them, so the eval counts what lint and drift see. */
export function readIndex(kb: Kb): { pages: PageRow[]; footnotes: FootnoteRow[] } {
  const db = openIndex(kb.indexPath, { readonly: true });
  try {
    const pages = db
      .query(
        `SELECT path, type, source, canonical_source, last_verified_revision, body
         FROM pages ORDER BY path`,
      )
      .all() as PageRow[];
    const footnotes = db
      .query(
        `SELECT page_path, footnote, line, text, source, revision, path, locator
         FROM citations ORDER BY page_path, line`,
      )
      .all() as FootnoteRow[];
    return { pages, footnotes };
  } finally {
    db.close();
  }
}
