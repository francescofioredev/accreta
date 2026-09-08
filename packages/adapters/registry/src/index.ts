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

/** Read every `*.yaml` declaration in `<root>/sources`, in a stable order. */
export function readDeclarations(root: string) {
  const dir = join(root, "sources");
  if (!existsSync(dir)) return [];

  return readdirSync(dir)
    .toSorted()
    .filter((name) => name.endsWith(".yaml") || name.endsWith(".yml"))
    .map((name) => parseSourceDeclaration(readFileSync(join(dir, name), "utf-8")));
}

/**
 * Every source declared in the workspace, keyed by id.
 *
 * Which is also where two declarations sharing an id are caught. It makes
 * `source:path` ambiguous and `pages.source` unable to tell them apart, so it
 * was never valid — but it was silent, and silent in two different ways: the
 * CLI built both and checked drift twice, the MCP server kept whichever file
 * sorted last.
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
