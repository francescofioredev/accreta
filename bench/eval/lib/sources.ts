import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseSourceDeclaration } from "@accreta/core";
import { revParse } from "./git.ts";

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

/** Drift compares against each source's HEAD, so `to` must be what every git source has checked out. */
export function checkTarget(kb: { root: string }, to: string | undefined): Record<string, string> {
  const heads: Record<string, string> = {};
  for (const s of declaredSources(kb.root).filter((d) => d.type === "git")) {
    const head = revParse(s.root, "HEAD");
    if (to !== undefined && revParse(s.root, to) !== head) {
      throw new Error(
        `source "${s.id}" has ${head.slice(0, 12)} checked out, not ${to}: check it out first`,
      );
    }
    heads[s.id] = head;
  }
  return heads;
}
