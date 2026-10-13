import { findWorkspace } from "../workspace.ts";
import { CLIENTS, install, SCOPES, type Client, type Scope } from "./mcp-config.ts";
import type { CommandContext } from "./shared.ts";

const USAGE = `Usage: accreta mcp
       accreta mcp install --client <${CLIENTS.join("|")}> [--scope project|user] [--force]

  mcp        Start the MCP server on stdio, for the knowledge base found from here.
             Point an MCP client at the command \`accreta\` with the argument \`mcp\`.
  install    Add that server to the client's config. --scope project (the default) writes
             a file in the knowledge base; user scope covers every project, and names this
             knowledge base. An existing accreta entry that differs is replaced only with
             --force. Claude Code and VS Code add user-scope servers themselves, so for
             those the command to run is printed instead.`;

interface McpArgs {
  sub?: string;
  client?: string;
  scope?: string;
  force: boolean;
}

/**
 * Pair the flags with their values in the raw arguments. `COMMAND_ARGS` has already refused any
 * flag mcp does not take.
 */
export function mcpArgs(args: readonly string[]): McpArgs {
  const parsed: McpArgs = { force: false };
  const positional: string[] = [];
  let endOfOptions = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (endOfOptions || !arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    if (arg === "--") {
      endOfOptions = true;
      continue;
    }
    const at = arg.indexOf("=");
    const name = at > 0 ? arg.slice(0, at) : arg;
    if (name === "--force") {
      if (at > 0) throw new Error("--force takes no value.");
      parsed.force = true;
    } else if (name === "--client" || name === "--scope") {
      const value = at > 0 ? arg.slice(at + 1) : args[++i];
      if (!value || value.startsWith("--")) throw new Error(`${name} needs a value.`);
      parsed[name === "--client" ? "client" : "scope"] = value;
    }
  }
  const [sub, ...extra] = positional;
  if (extra.length > 0) throw new Error(`mcp does not take "${extra.join(" ")}".`);
  parsed.sub = sub;
  return parsed;
}

export async function mcp(ctx: CommandContext, args: readonly string[] = []): Promise<number> {
  let parsed: McpArgs;
  try {
    parsed = mcpArgs(args);
  } catch (error) {
    ctx.err((error as Error).message);
    return 2;
  }
  const { sub } = parsed;
  if (sub === "help") {
    ctx.out(USAGE);
    return 0;
  }
  if (sub === "install") return runInstall(ctx, parsed);
  if (sub !== undefined) {
    ctx.err(`Unknown mcp subcommand "${sub}".\n`);
    ctx.err(USAGE);
    return 2;
  }
  // A flag for install must not quietly start a server instead.
  if (parsed.client !== undefined || parsed.scope !== undefined || parsed.force) {
    ctx.err("--client, --scope and --force go with `accreta mcp install`.");
    return 2;
  }
  // Loaded here, not at the top, so every other command skips loading the MCP SDK.
  const { serveStdio } = await import("@accreta/mcp-server");
  await serveStdio(ctx.cwd);
  return 0;
}

function runInstall(ctx: CommandContext, parsed: McpArgs): number {
  const { client, scope = "project" } = parsed;
  if (!CLIENTS.includes(client as Client)) {
    ctx.err(
      client === undefined
        ? `mcp install needs --client ${CLIENTS.join("|")}.`
        : `--client takes ${CLIENTS.join(", ")}, not "${client}".`,
    );
    return 2;
  }
  if (!SCOPES.includes(scope as Scope)) {
    ctx.err(`--scope takes project or user, not "${scope}".`);
    return 2;
  }
  const workspace = findWorkspace(ctx.cwd);
  return install(ctx, workspace.root, {
    client: client as Client,
    scope: scope as Scope,
    force: parsed.force,
  });
}
