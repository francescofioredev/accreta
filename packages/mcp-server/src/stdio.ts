import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createContext } from "./context.ts";
import { createServer } from "./server.ts";

/** Serve the knowledge base found from `cwd` over stdio; shared by `accreta-mcp` and `accreta mcp`. */
export async function serveStdio(cwd: string = process.cwd()): Promise<void> {
  const server = createServer(createContext(cwd));
  // stdio is the transport Claude Code and other local clients use. Nothing
  // may be written to stdout except protocol traffic, which is why every
  // diagnostic here goes to stderr.
  await server.connect(new StdioServerTransport());
  console.error("accreta MCP server ready on stdio");
}

/** What the `accreta-mcp` bin runs, through bin.ts. */
export async function main(): Promise<number> {
  try {
    await serveStdio();
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
