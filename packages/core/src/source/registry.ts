import { parse as parseYaml } from "yaml";
import type { SourceAdapter } from "./adapter.ts";

/**
 * A source as declared in configuration, before an adapter is built for it.
 *
 * `type` selects which adapter constructs it, and every remaining key is passed
 * through untouched. The core neither knows nor validates what an adapter needs
 * — that is the adapter's business, and putting the knowledge here is how a
 * registry starts growing `if (type === "git")` branches.
 */
export interface SourceDeclaration {
  id: string;
  type: string;
  options: Record<string, unknown>;
}

export type SourceFactory = (declaration: SourceDeclaration) => SourceAdapter;

/**
 * Parse a `sources/*.yaml` document.
 *
 * ```yaml
 * id: ipcc-ar6-wg1
 * type: fs
 * root: sources/ipcc
 * extensions: [".md", ".txt"]
 * ```
 */
export function parseSourceDeclaration(source: string): SourceDeclaration {
  const data = parseYaml(source) as unknown;
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("A source declaration must be a YAML mapping");
  }

  const raw = data as Record<string, unknown>;
  const { id, type, ...options } = raw;

  if (typeof id !== "string" || id.length === 0) {
    throw new Error("A source declaration needs a non-empty `id`");
  }
  if (typeof type !== "string" || type.length === 0) {
    throw new Error(`Source "${id}" needs a non-empty \`type\``);
  }

  return { id, type, options };
}

/**
 * Builds adapters from declarations.
 *
 * Adapters register themselves by type name, so adding a source kind means
 * adding a package and one registration — never editing the core. A registry
 * that grew a `switch (type)` would put every adapter's name back into the
 * module that exists to not know them.
 */
export class SourceRegistry {
  private readonly factories = new Map<string, SourceFactory>();

  register(type: string, factory: SourceFactory): this {
    this.factories.set(type, factory);
    return this;
  }

  create(declaration: SourceDeclaration): SourceAdapter {
    const factory = this.factories.get(declaration.type);
    if (!factory) {
      const known = [...this.factories.keys()].toSorted().join(", ") || "none";
      throw new Error(
        `Unknown source type "${declaration.type}" for source "${declaration.id}". ` +
          `Registered types: ${known}.`,
      );
    }
    return factory(declaration);
  }

  has(type: string): boolean {
    return this.factories.has(type);
  }
}
