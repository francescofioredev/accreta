import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseSourceDeclaration, SourceRegistry, type SourceAdapter } from "@accreta/core";
import { KINDS, type SourceContext } from "./kinds.ts";

export type { AgentAccess, Preflight, SourceContext, SourceKind } from "./kinds.ts";
export { KINDS, KNOWN_TYPES, kindFor } from "./kinds.ts";

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

/** A declaration in `sources/` that did not become an adapter. */
export interface UnloadedSource {
  /** Relative to the workspace root: the file somebody has to open. */
  file: string;
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

  for (const file of declarationFiles(ctx.root)) {
    let declaration;
    try {
      declaration = parseSourceDeclaration(readFileSync(join(ctx.root, file), "utf-8"));
    } catch (error) {
      unloaded.push({ file, reason: messageOf(error) });
      continue;
    }
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
      unloaded.push({ file, reason: messageOf(error) });
    }
  }
  return { sources, unloaded };
}

/** The same finding for the CLI and the MCP server, so they cannot word it differently. */
export function unloadedFindings(unloaded: readonly UnloadedSource[]) {
  return unloaded.map((source) => ({
    kind: "unloaded-source" as const,
    path: source.file,
    detail: `not loaded, so nothing citing it was checked: ${source.reason}`,
  }));
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));
