import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseSourceDeclaration } from "@accreta/core";
import { KNOWN_TYPES, kindFor } from "@accreta/adapters";
import { findWorkspace } from "../workspace.ts";
import { reportPreflight, type CommandContext } from "./shared.ts";

/**
 * Write a source declaration, then say whether anything can reach it. `--set` pairs go in
 * untouched: the CLI knows no more about a source's options than the core does.
 */
export async function sourceAdd(
  ctx: CommandContext,
  type: string,
  id: string,
  overrides: Record<string, string>,
): Promise<number> {
  if (!type || !id) {
    ctx.err("Usage: accreta source add <type> <id> [--set key=value]");
    ctx.err(`Types: ${KNOWN_TYPES.join(", ")}`);
    return 2;
  }

  const kind = kindFor(type);
  if (!kind) {
    ctx.err(`Unknown source type "${type}". Known: ${KNOWN_TYPES.join(", ")}.`);
    return 2;
  }

  const workspace = findWorkspace(ctx.cwd);
  const dir = join(workspace.root, "sources");
  mkdirSync(dir, { recursive: true });

  const path = join(dir, `${id}.yaml`);
  if (existsSync(path)) {
    ctx.err(`sources/${id}.yaml already exists. Leaving it alone.`);
    return 1;
  }

  writeFileSync(path, applyOverrides(kind.template(id), overrides), "utf-8");
  ctx.out(`Wrote sources/${id}.yaml`);

  const preflight = await kind.preflight(
    { id, type, options: parseSourceDeclaration(readFileSync(path, "utf-8")).options },
    { root: workspace.root, citationFormat: workspace.config.provenanceFormat },
  );
  reportPreflight(ctx, preflight, "  ");
  return 0;
}

/** Replace `key: …` lines the user overrode, leaving the template's comments in place. */
function applyOverrides(template: string, overrides: Record<string, string>): string {
  let out = template;
  for (const [key, value] of Object.entries(overrides)) {
    const line = new RegExp(`^${key}:.*$`, "m");
    out = line.test(out) ? out.replace(line, `${key}: ${value}`) : `${out}${key}: ${value}\n`;
  }
  return out;
}
