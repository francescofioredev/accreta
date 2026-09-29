import type { CommandContext } from "./shared.ts";

const USAGE = `Usage: accreta mcp

  Start the MCP server on stdio, for the knowledge base found from here.
  Point an MCP client at the command \`accreta\` with the argument \`mcp\`.`;

export async function mcp(ctx: CommandContext, args: string[]): Promise<number> {
  const [sub] = args;
  if (sub === "help") {
    ctx.out(USAGE);
    return 0;
  }
  if (sub !== undefined) {
    ctx.err(`Unknown mcp subcommand "${sub}".\n`);
    ctx.err(USAGE);
    return 2;
  }
  // Loaded here, not at the top, so every other command skips loading the MCP SDK.
  const { serveStdio } = await import("@accreta/mcp-server");
  await serveStdio(ctx.cwd);
  return 0;
}
