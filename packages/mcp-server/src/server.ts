import { readFileSync } from "node:fs";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v3";

/**
 * Register a tool with its input shape typed loosely at the boundary.
 *
 * The SDK infers a handler's argument type from the zod shape it is given, and
 * inferring that across every tool at once exceeds TypeScript's instantiation
 * depth. The shapes are still real zod schemas — the SDK validates against them
 * at runtime before a handler ever sees the input — so the narrowing lost here
 * is narrowing that was never load-bearing.
 */
type ToolResult = { content: { type: "text"; text: string }[] };
type ToolHandler<I> = (input: I) => Promise<ToolResult>;
import type { ToolContext } from "./tools.ts";
import {
  checkDriftTool,
  findCanonicalTool,
  findConsumersTool,
  getPageTool,
  lintTool,
  listRecentChangesTool,
  searchPagesTool,
  updateVerifiedRevisionTool,
} from "./tools.ts";

/**
 * The version this server reports to a client during `initialize`.
 *
 * Read from the manifest rather than restated, because a restated version
 * drifts: this was hardcoded at 0.1.0 for two releases while the package was at
 * 0.1.2, so a client asking "which accreta am I talking to" got the wrong
 * answer. `readFileSync` rather than a JSON import so no `resolveJsonModule` is
 * needed across every package's shared tsconfig; `files` does not list the
 * manifest, but npm always ships `package.json` at the tarball root, so this
 * resolves both in the repository and in an installed copy.
 *
 * The *name* stays a literal on purpose: `accreta` is the protocol identity a
 * client displays, not the npm package name `@accreta/mcp-server`.
 */
const VERSION = (
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf-8")) as {
    version: string;
  }
).version;

/** Wrap a result as MCP tool content. */
function json(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

export function createServer(ctx: ToolContext): McpServer {
  const server = new McpServer({ name: "accreta", version: VERSION });
  const register = server.registerTool.bind(server) as <I>(
    name: string,
    config: { description: string; inputSchema: Record<string, unknown> },
    handler: ToolHandler<I>,
  ) => void;

  register(
    "search_pages",
    {
      description:
        "Full-text search across the knowledge base (title and body), with optional filters on page type and source. The primary discovery tool: use it when you do not already know a page's path. Supports FTS5 syntax — phrases in double quotes, AND/OR/NOT.",
      inputSchema: {
        query: z.string().min(1).describe("Search query. Supports FTS5 syntax."),
        types: z
          .array(z.string())
          .optional()
          .describe("Restrict to these page types, as configured in accreta.config.yaml."),
        source: z.string().optional().describe("Restrict to pages derived from this source."),
        limit: z.number().int().positive().max(50).optional().describe("Max results; default 20."),
      },
    },
    async (input: { query: string; types?: string[]; source?: string; limit?: number }) =>
      json(searchPagesTool(ctx, input)),
  );

  register(
    "get_page",
    {
      description:
        "Fetch one page by path or by wikilink target. Returns frontmatter, body, and the revision the page was last verified against.",
      inputSchema: {
        path: z
          .string()
          .min(1)
          .describe("Page path ('knowledge/concepts/x.md') or wikilink target ('concepts/x')."),
      },
    },
    async (input: { path: string }) => json(getPageTool(ctx, input)),
  );

  register(
    "find_consumers",
    {
      description:
        "Impact analysis across the link graph. Returns both directions, distinguished by a `direction` field: 'inbound' means another page points at this one, 'outbound' means this page points elsewhere. Use for 'what depends on X' and 'where is X discussed'. Inline [[mentions]] are excluded unless include_inline is set.",
      inputSchema: {
        target: z.string().min(1).describe("Page path or wikilink target."),
        kinds: z
          .array(z.string())
          .optional()
          .describe(
            "Restrict to these relation kinds (the configured link_fields, or 'wikilink').",
          ),
        include_inline: z
          .boolean()
          .optional()
          .describe("Include untyped inline [[mentions]]. Noisier but exhaustive."),
      },
    },
    async (input: { target: string; kinds?: string[]; include_inline?: boolean }) =>
      json(findConsumersTool(ctx, input)),
  );

  register(
    "find_canonical",
    {
      description:
        "Resolve a term to the page that authoritatively defines it, consulting titles and frontmatter aliases. Use when you have a name and need the definition rather than a list of mentions.",
      inputSchema: { term: z.string().min(1).describe("Concept name or alias.") },
    },
    async (input: { term: string }) => json(findCanonicalTool(ctx, input)),
  );

  register(
    "check_drift",
    {
      description:
        "Report which pages their sources have moved out from under. Distinguishes three outcomes that must not be confused: `stale` (the source changed since the page was verified), `unverifiable` (the page records no revision at all), and `unresolvable` (the source cannot place the revision the page names — history rewritten, or a revision from a previous run). Only the absence of all three means 'current'. `stale` and `unresolvable` group by revision — each entry carries the revision and the list of pages verified against it — so a page appears inside an entry rather than as one.",
      inputSchema: {
        source: z.string().optional().describe("Check one source. Omit to check all of them."),
      },
    },
    async (input: { source?: string }) => json(await checkDriftTool(ctx, input)),
  );

  register(
    "list_recent_changes",
    {
      description:
        "What changed in a source since a given revision. Returns `unresolvable: true` when the source cannot place the revision — which is not the same answer as an empty change list.",
      inputSchema: {
        source: z.string().min(1).describe("Source id, as declared in sources/."),
        since: z.string().min(1).describe("Revision to compare against."),
      },
    },
    async (input: { source: string; since: string }) =>
      json(await listRecentChangesTool(ctx, input)),
  );

  register(
    "lint_knowledge_base",
    {
      description:
        "Report what is wrong with the knowledge base: links that do not resolve, links to pages that do not exist, page types outside the configured vocabulary, pages missing provenance or a verified revision, and citations whose path or line range does not exist in the source.",
      inputSchema: {},
    },
    async () => json(await lintTool(ctx)),
  );

  // The write tool is registered only when writes are enabled, so a read-only
  // deployment does not advertise a capability it will refuse to exercise.
  if (ctx.writesEnabled) {
    register(
      "update_verified_revision",
      {
        description:
          "Record the revision a page has been verified against. Two-step: call without confirm_token to get a dry run describing the edit and a token, then call again echoing that token. The token is derived from the page, the new revision and the current value, so it cannot be reused for a different edit.",
        inputSchema: {
          path: z.string().min(1).describe("Page path or wikilink target."),
          revision: z.string().min(1).describe("Revision the page has been verified against."),
          confirm_token: z
            .string()
            .optional()
            .describe("Token returned by the dry run. Omit for the dry run itself."),
        },
      },
      async (input: { path: string; revision: string; confirm_token?: string }) =>
        json(updateVerifiedRevisionTool(ctx, input)),
    );
  }

  return server;
}
