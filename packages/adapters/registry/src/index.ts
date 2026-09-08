import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  parseSourceDeclaration,
  SourceRegistry,
  type SourceAdapter,
  type SourceDeclaration,
} from "@accreta/core";
import { FsSource } from "@accreta/adapter-fs";
import { GitSource } from "@accreta/adapter-git";

export interface SourceContext {
  /** Workspace root. A declaration's own `root` is resolved against it. */
  root: string;
  /** `provenance.format`, handed to every adapter as its citation template. */
  citationFormat: string;
}

/** A declaration's options reach the adapter untouched, so shaping them is the surface's job. */
function stringsOr(value: unknown, fallback?: string[]): string[] | undefined {
  return Array.isArray(value) ? (value as string[]) : fallback;
}

/**
 * The adapters this build knows how to construct.
 *
 * Not in the core, whose whole purpose is not to know which adapters exist. Not
 * in each surface either, which is where it was: the CLI and the MCP server
 * carried the same two registrations and the same hand-written option
 * marshalling, copied line for line, and the copies were free to disagree about
 * what a declaration means. A third adapter would have made three of them.
 */
export function buildRegistry(ctx: SourceContext): SourceRegistry {
  return new SourceRegistry()
    .register(
      "fs",
      (d) =>
        new FsSource({
          id: d.id,
          root: join(ctx.root, String(d.options.root ?? ".")),
          citationFormat: ctx.citationFormat,
          extensions: stringsOr(d.options.extensions),
        }),
    )
    .register(
      "git",
      (d) =>
        new GitSource({
          id: d.id,
          root: join(ctx.root, String(d.options.root ?? ".")),
          citationFormat: ctx.citationFormat,
          paths: stringsOr(d.options.paths),
        }),
    );
}

/** Read every `*.yaml` declaration in `<root>/sources`, in a stable order. */
export function readDeclarations(root: string): SourceDeclaration[] {
  const dir = join(root, "sources");
  if (!existsSync(dir)) return [];

  const out: SourceDeclaration[] = [];
  for (const name of readdirSync(dir).toSorted()) {
    if (!name.endsWith(".yaml") && !name.endsWith(".yml")) continue;
    out.push(parseSourceDeclaration(readFileSync(join(dir, name), "utf-8")));
  }
  return out;
}

/**
 * Every source declared in the workspace, keyed by id.
 *
 * Which is also where two declarations sharing an id are caught. It makes
 * `source:path` ambiguous and `pages.source` unable to tell them apart, so it
 * was never valid — but it was silent, and silent in two different ways: the
 * CLI built both and checked drift twice, the MCP server kept whichever file
 * sorted last. Neither behaviour is worth preserving over saying so.
 */
export function loadSources(ctx: SourceContext): Map<string, SourceAdapter> {
  const registry = buildRegistry(ctx);
  const out = new Map<string, SourceAdapter>();

  for (const declaration of readDeclarations(ctx.root)) {
    if (out.has(declaration.id)) {
      throw new Error(
        `Two sources in sources/ are declared with id "${declaration.id}". ` +
          `An id names a source in every citation, so it has to name only one.`,
      );
    }
    out.set(declaration.id, registry.create(declaration));
  }
  return out;
}
