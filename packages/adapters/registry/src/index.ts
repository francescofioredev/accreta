import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  countPagesCiting,
  DelegatedSourceError,
  detectDrift,
  parseSourceDeclaration,
  SourceDeclarationError,
  SourceRegistry,
  type Database,
  type DriftReport,
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
  { file: string; declaration: SourceDeclaration } | { file: string; error: string; id?: string };

/** Every declaration file, each read on its own so a bad one is reported against itself. */
export function readDeclarationFiles(root: string): DeclarationFile[] {
  return declarationFiles(root).map((file) => {
    try {
      return { file, declaration: parseSourceDeclaration(readFileSync(join(root, file), "utf-8")) };
    } catch (error) {
      const id = error instanceof SourceDeclarationError ? error.sourceId : undefined;
      return { file, error: firstLine(error), ...(id === undefined ? {} : { id }) };
    }
  });
}

/** The id a file claims. One that failed only on `type` still claims it, or the other would win. */
export const declaredId = (entry: DeclarationFile) =>
  "error" in entry ? entry.id : entry.declaration.id;

/** Each id more than one file declares, with those files in order: a citation can name only one. */
export function clashingIds(entries: readonly DeclarationFile[]): Map<string, string[]> {
  const filesById = new Map<string, string[]>();
  for (const entry of entries) {
    const id = declaredId(entry);
    if (id !== undefined) filesById.set(id, [...(filesById.get(id) ?? []), entry.file]);
  }
  return new Map([...filesById].filter(([, files]) => files.length > 1));
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
 * A shared id loads none of its declarations, since keeping one would be picking a winner.
 */
export function loadSources(ctx: SourceContext): LoadedSources {
  const registry = buildRegistry(ctx);
  const sources = new Map<string, SourceAdapter>();
  const unloaded: UnloadedSource[] = [];
  const entries = readDeclarationFiles(ctx.root);
  const clashes = clashingIds(entries);

  for (const entry of entries) {
    const { file } = entry;
    const id = declaredId(entry);
    const others =
      id === undefined ? [] : (clashes.get(id)?.filter((other) => other !== file) ?? []);
    if (others.length > 0) {
      unloaded.push({
        file,
        id,
        reason:
          `id \`${id}\` is also declared in ${others.join(", ")}; ` +
          `give each a distinct id or remove all but one`,
      });
      continue;
    }
    if ("error" in entry) {
      unloaded.push({ file, ...(id === undefined ? {} : { id }), reason: entry.error });
      continue;
    }
    const { declaration } = entry;
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

/** Why `id` names no source; a declaration that did not load may be the one meant. */
export function noSourceNamed(
  id: string,
  known: readonly string[],
  unloaded: readonly UnloadedSource[],
): string {
  const broken = unloaded.map((u) => (u.id === undefined ? `${u.file} (no id)` : u.file));
  const loose = broken.length > 0 ? ` Did not load: ${broken.join(", ")}.` : "";
  return `No source named "${id}". Known: ${known.join(", ") || "none"}.${loose}`;
}

/** Each source's drift report; one whose revision fails is returned as unloaded, failing no other. */
export async function detectDriftEach(
  db: Database,
  adapters: readonly SourceAdapter[],
  root: string,
): Promise<{ reports: DriftReport[]; unreadable: UnloadedSource[] }> {
  const reports: DriftReport[] = [];
  const unreadable: UnloadedSource[] = [];
  for (const adapter of adapters) {
    // Asked out here, so an index error inside detectDrift still fails the call.
    const revision = (async () => adapter.revision())();
    try {
      await revision;
    } catch (error) {
      if (!(error instanceof DelegatedSourceError)) {
        const declared = readDeclarationFiles(root).find((e) => declaredId(e) === adapter.id);
        unreadable.push({
          file: declared?.file ?? "sources",
          id: adapter.id,
          reason: `its revision could not be read: ${firstLine(error)}`,
        });
        continue;
      }
    }
    const answered = new Proxy(adapter, {
      get(target, prop) {
        if (prop === "revision") return () => revision;
        const value: unknown = Reflect.get(target, prop);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    reports.push(await detectDrift(db, answered));
  }
  return { reports, unreadable };
}

/** cite's refusal of a source that did not load. Its reason is declaration text, which an error cannot label. */
export const notLoadedError = (id: string) =>
  `Source "${id}" is declared but did not load; drift and lint report why.`;

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
