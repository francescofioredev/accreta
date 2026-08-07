#!/usr/bin/env bun
import { canonical, consumers, drift, init, reindex, runLint, search, show } from "./commands.ts";
import type { CommandContext } from "./commands.ts";

const USAGE = `accreta — a knowledge base an agent writes and keeps current

Usage: accreta <command> [arguments]

  init                     Create accreta.config.yaml, knowledge/ and sources/
  reindex                  Rebuild the index from the knowledge base
  lint                     Report unresolvable links, missing provenance, unknown types
  drift                    Report which pages their sources have moved out from under
  search <query>           Full-text search (--type <type>, repeatable)
  show <path|wikilink>     Print a page
  consumers <path>         What links to this page, and what it links to (--inline)
  canonical <term>         Resolve a term to the page that defines it

Environment:
  ACCRETA_ROOT             Use this directory instead of searching upward
  ACCRETA_INDEX_PATH       Keep the index somewhere other than .accreta/
`;

/** Collect repeated `--type x` flags, returning them with the positional rest. */
function parseArgs(argv: string[]): {
  positional: string[];
  types: string[];
  includeInline: boolean;
} {
  const positional: string[] = [];
  const types: string[] = [];
  let includeInline = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--type" || arg === "-t") {
      const value = argv[++i];
      if (value) types.push(value);
      continue;
    }
    if (arg === "--inline") {
      includeInline = true;
      continue;
    }
    if (arg !== undefined) positional.push(arg);
  }
  return { positional, types, includeInline };
}

export async function run(argv: string[], ctx: CommandContext): Promise<number> {
  const [command, ...rest] = argv;
  const { positional, types, includeInline } = parseArgs(rest);

  switch (command) {
    case undefined:
    case "help":
    case "--help":
    case "-h":
      ctx.out(USAGE);
      return 0;
    case "init":
      return init(ctx);
    case "reindex":
      return reindex(ctx);
    case "lint":
      return runLint(ctx);
    case "drift":
      return drift(ctx);
    case "search":
      return search(ctx, positional.join(" "), types.length > 0 ? types : undefined);
    case "show":
      return show(ctx, positional[0] ?? "");
    case "consumers":
      return consumers(ctx, positional[0] ?? "", { includeInline });
    case "canonical":
      return canonical(ctx, positional.join(" "));
    default:
      ctx.err(`Unknown command "${command}".\n`);
      ctx.err(USAGE);
      return 1;
  }
}

if (import.meta.main) {
  const ctx: CommandContext = {
    cwd: process.cwd(),
    out: (line) => console.log(line),
    err: (line) => console.error(line),
  };

  try {
    process.exitCode = await run(process.argv.slice(2), ctx);
  } catch (error) {
    // A message, not a stack trace: these are conditions a user can act on
    // ("no index, run reindex"), not internal failures.
    ctx.err(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
