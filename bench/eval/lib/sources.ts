import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseSourceDeclaration } from "@accreta/core";

export interface DeclaredSource {
  file: string;
  id: string;
  type: string;
  /** Absolute: a declaration's `root` is resolved against the knowledge base, as the registry does. */
  root: string;
  paths: string[];
}

/** The declarations in `<kb>/sources` that parse; the ones that do not are lint's to report. */
export function declaredSources(kbRoot: string): DeclaredSource[] {
  const dir = join(kbRoot, "sources");
  if (!existsSync(dir)) return [];
  const out: DeclaredSource[] = [];
  for (const name of readdirSync(dir).toSorted()) {
    if (!name.endsWith(".yaml") && !name.endsWith(".yml")) continue;
    try {
      const d = parseSourceDeclaration(readFileSync(join(dir, name), "utf-8"));
      const paths = Array.isArray(d.options.paths) ? d.options.paths.map(String) : [];
      const root = join(kbRoot, String(d.options.root ?? "."));
      out.push({ file: join("sources", name), id: d.id, type: d.type, root, paths });
    } catch {
      continue;
    }
  }
  return out;
}
