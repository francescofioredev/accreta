import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  countPagesCiting,
  parseSourceDeclaration,
  SourceRegistry,
  type Database,
  type SourceAdapter,
  type SourceDeclaration,
} from "@accreta/core";
import { KINDS, type SourceContext } from "./kinds.ts";

export type { AgentAccess, Preflight, SourceContext, SourceKind } from "./kinds.ts";
export { KINDS, KNOWN_TYPES, kindFor, stateDirFor } from "./kinds.ts";

/**
 * The adapters this build knows how to construct.
 *
 * Not in the core, whose whole purpose is not to know which adapters exist. Not
 * in each surface either, which is where it was: the CLI and the MCP server
 * carried the same registrations and the same hand-written option marshalling,
 * copied line for line, and the copies were free to disagree about what a
 * declaration means.
 */
export function buildRegistry(ctx: SourceContext): SourceRegistry {
  const registry = new SourceRegistry();
  for (const kind of KINDS) {
    registry.register(kind.type, (declaration) => kind.create(declaration, ctx));
  }
  return registry;
}

/** The declaration files in `<root>/sources`, relative to `root`, in a stable order. */
function declarationFiles(root: string): string[] {
  const dir = join(root, "sources");
  if (!existsSync(dir)) return [];

  return readdirSync(dir)
    .toSorted()
    .filter((name) => name.endsWith(".yaml") || name.endsWith(".yml"))
    .map((name) => join("sources", name));
}

/** Read every `*.yaml` declaration in `<root>/sources`, in a stable order. */
export function readDeclarations(root: string) {
  return declarationFiles(root).map((file) =>
    parseSourceDeclaration(readFileSync(join(root, file), "utf-8")),
  );
}

/** One `sources/*.yaml` file, relative to the workspace root: its declaration, or why it is not one. */
export type DeclarationFile =
  { file: string; declaration: SourceDeclaration } | { file: string; error: string };

/** Every declaration file, each read on its own so a bad one is reported against itself. */
export function readDeclarationFiles(root: string): DeclarationFile[] {
  return declarationFiles(root).map((file) => {
    try {
      return { file, declaration: parseSourceDeclaration(readFileSync(join(root, file), "utf-8")) };
    } catch (error) {
      return { file, error: firstLine(error) };
    }
  });
}

/** A declaration in `sources/` that did not become an adapter. */
export interface UnloadedSource {
  /** Relative to the workspace root: the file somebody has to open. */
  file: string;
  /** Absent when the file did not parse far enough to name one. */
  id?: string;
  reason: string;
}

export interface LoadedSources {
  /** Every source that built, keyed by id. */
  sources: Map<string, SourceAdapter>;
  unloaded: UnloadedSource[];
}

/**
 * Every source that builds, plus each declaration that did not: one half-written file
 * must not stop lint, drift and the MCP server for every other source.
 * A shared id still throws, since keeping either declaration would be picking a winner.
 */
export function loadSources(ctx: SourceContext): LoadedSources {
  const registry = buildRegistry(ctx);
  const sources = new Map<string, SourceAdapter>();
  const unloaded: UnloadedSource[] = [];
  const seen = new Set<string>();

  for (const entry of readDeclarationFiles(ctx.root)) {
    if ("error" in entry) {
      unloaded.push({ file: entry.file, reason: entry.error });
      continue;
    }
    const { file, declaration } = entry;
    if (seen.has(declaration.id)) {
      throw new Error(
        `Two sources in sources/ are declared with id "${declaration.id}". ` +
          `An id names a source in every citation, so it has to name only one.`,
      );
    }
    seen.add(declaration.id);
    try {
      sources.set(declaration.id, registry.create(declaration));
    } catch (error) {
      unloaded.push({ file, id: declaration.id, reason: firstLine(error) });
    }
  }
  return { sources, unloaded };
}

/** An unloaded source and how many pages cite it; `pages` is null when there is no id to count by. */
export interface UncheckedSource extends UnloadedSource {
  pages: number | null;
}

/** Size what went unchecked, as lint does for a delegated source, rather than just flag it. */
export function countUnchecked(
  db: Database,
  unloaded: readonly UnloadedSource[],
): UncheckedSource[] {
  return unloaded.map((source) => ({
    ...source,
    pages: source.id === undefined ? null : countPagesCiting(db, source.id),
  }));
}

export const uncheckedPages = (pages: number | null) =>
  pages === null
    ? "an unknown number of pages cite it and were not checked"
    : `${pages} page(s) cite it and were not checked`;

/** The same finding for the CLI and the MCP server, so they cannot word it differently. */
export function unloadedFindings(unchecked: readonly UncheckedSource[]) {
  return unchecked.map((source) => ({
    kind: "unloaded-source" as const,
    path: source.file,
    detail: `did not load, so ${uncheckedPages(source.pages)}: ${source.reason}`,
  }));
}

// First line only: a YAML error quotes the file after it, and reasons reach PR comments.
function firstLine(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split("\n")[0]!.trim();
}
