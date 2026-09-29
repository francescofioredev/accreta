import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { checkConfig, compileCitationTemplate, DEFAULT_CONFIG } from "@accreta/core";
import { KNOWN_TYPES, kindFor, readDeclarations } from "@accreta/adapters";
import { CONFIG_FILENAME, findWorkspace } from "../workspace.ts";
import { reportPreflight, type CommandContext } from "./shared.ts";
import {
  CLI_VERSION,
  compareVersions,
  findInstalledSkills,
  SKILL_NAME,
  skillDirectories,
} from "./skill-floor.ts";

/**
 * Say what is wired up and what is not, read-only, and never guess at the difference. Whether
 * the agent can reach a delegated source is recorded in no file here, so it stays unverified.
 */
export async function doctor(ctx: CommandContext): Promise<number> {
  const workspace = findWorkspace(ctx.cwd);
  let exitCode = 0;
  ctx.out(`accreta doctor — ${workspace.root}`);

  ctx.out("\nconfig");
  const check = checkConfig(readFileSync(join(workspace.root, CONFIG_FILENAME), "utf-8"));
  if (check.error) {
    // Everything else reads this file through `parseConfig`, which degrades to
    // the defaults rather than throwing. That is the right trade there and it
    // means a knowledge base can lint against page types nobody chose.
    ctx.out(`  broken: ${CONFIG_FILENAME} did not parse — ${check.error}`);
    ctx.out("    → every command is running on the default vocabulary, silently");
    exitCode = 1;
  } else {
    ctx.out(`  ok: ${CONFIG_FILENAME} parses`);
  }
  const format = compileCitationTemplate(workspace.config.provenanceFormat);
  if (!format.ok) {
    ctx.out(`  unreadable: ${format.reason}`);
    ctx.out("    → footnote citations cannot be checked until it separates each placeholder");
    exitCode = 1;
  }
  if (/\{start\}|\{end\}/.test(workspace.config.provenanceFormat)) {
    ctx.out("  stale: provenance.format still uses {start} and {end}");
    ctx.out(`    → replace them with {locator}: "${DEFAULT_CONFIG.provenanceFormat}"`);
  }

  ctx.out("\nindex");
  ctx.out(
    existsSync(workspace.indexPath)
      ? `  ok: ${workspace.indexPath}`
      : "  missing: run `accreta reindex`",
  );

  const declarations = readDeclarations(workspace.root);
  ctx.out(`\nsources (${declarations.length})`);
  if (declarations.length === 0) ctx.out("  none declared in sources/");

  for (const declaration of declarations) {
    ctx.out(`  ${declaration.id} — ${declaration.type}`);
    const kind = kindFor(declaration.type);
    if (!kind) {
      ctx.out(`    no: unknown source type. Known: ${KNOWN_TYPES.join(", ")}.`);
      exitCode = 1;
      continue;
    }
    // Preflight never constructs the adapter, so a half-written declaration is
    // reported here rather than thrown from a diagnostic command.
    const preflight = await kind.preflight(declaration, {
      root: workspace.root,
      citationFormat: workspace.config.provenanceFormat,
    });
    reportPreflight(ctx, preflight, "    ");
    if (preflight.reachable === "no") exitCode = 1;
  }

  ctx.out("\nmcp");
  ctx.out(
    mentionsAccretaServer(workspace.root)
      ? "  ok: .mcp.json in this workspace names accreta's server"
      : "  unknown: no .mcp.json here names accreta's server — the agent may be configured elsewhere",
  );

  reportSkill(ctx, workspace.root);

  return exitCode;
}

/** Never a failure: the copy found may not be the one the agent loads, and none found proves nothing. */
function reportSkill(ctx: CommandContext, root: string): void {
  ctx.out("\nskill");
  const pinned = `npx skills add "https://github.com/francescofioredev/accreta/tree/v${CLI_VERSION}/skills/${SKILL_NAME}"`;
  const installed = findInstalledSkills(root);
  if (installed.length === 0) {
    const searched = skillDirectories(root).map((dir) => dir.label);
    ctx.out(
      `  unknown: no ${SKILL_NAME} in ${searched.join(", ")} — the agent may load it from elsewhere`,
    );
  }
  for (const skill of installed) {
    if (!skill.floor.ok) {
      ctx.out(`  unknown: ${skill.where} found, but ${skill.floor.reason}`);
      ctx.out(`    → reinstall it pinned to this release: ${pinned}`);
    } else if (compareVersions(skill.floor.requires, CLI_VERSION) > 0) {
      ctx.out(`  stale: ${skill.where} requires ${skill.floor.requires}, this is ${CLI_VERSION}`);
      ctx.out(`    → upgrade accreta, or pin the skill to this release: ${pinned}`);
    } else {
      ctx.out(`  ok: ${skill.where} found, requires ${skill.floor.requires}`);
    }
  }
}

/** Only this workspace's file. An agent configured elsewhere is invisible, and saying so is the point. */
function mentionsAccretaServer(root: string): boolean {
  const path = join(root, ".mcp.json");
  if (!existsSync(path)) return false;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as {
      mcpServers?: Record<string, unknown>;
    };
    return Object.keys(parsed.mcpServers ?? {}).some((name) => name.includes("accreta"));
  } catch {
    return false;
  }
}
