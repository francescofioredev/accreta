#!/usr/bin/env bun
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createContext } from "./context.ts";
import { createServer } from "./server.ts";

if (import.meta.main) {
  try {
    const server = createServer(createContext());
    // stdio is the transport Claude Code and other local clients use. Nothing
    // may be written to stdout except protocol traffic, which is why every
    // diagnostic here goes to stderr.
    await server.connect(new StdioServerTransport());
    console.error("accreta MCP server ready on stdio");
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
