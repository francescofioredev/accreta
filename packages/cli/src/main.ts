#!/usr/bin/env bun
import { readFileSync } from "node:fs";

import {
  canonical,
  consumers,
  doctor,
  drift,
  init,
  reindex,
  runLint,
  search,
  show,
  sourceAdd,
} from "./commands.ts";
import type { CommandContext } from "./commands.ts";

const USAGE = `accreta — a knowledge base an agent writes and keeps current

Usage: accreta <command> [arguments]

  init [--preset <name>]   Create accreta.config.yaml, knowledge/, sources/ and
                           a constitution. Presets: codebase, research
  reindex                  Rebuild the index from the knowledge base
  lint                     Report unresolvable links, missing provenance, unknown types
  drift [--strict]         Report which pages their sources have moved out from under.
                           --strict also fails on anything left unchecked
  doctor                   Report what is wired up, and what cannot be checked from here
  source add <type> <id>   Write a source declaration (--set key=value, repeatable)
  search <query>           Full-text search (--type <type>, repeatable)
  show <path|wikilink>     Print a page
  consumers <path>         What links to this page, and what it links to (--inline)
  canonical <term>         Resolve a term to the page that defines it

  --version, -v            Print the version

Environment:
  ACCRETA_ROOT             Use this directory instead of searching upward
  ACCRETA_INDEX_PATH       Keep the index somewhere other than .accreta/
`;

/**
 * Read from the manifest rather than restated, for the reason recorded in the
 * MCP server's copy: a restated version drifts. npm always ships `package.json`
 * at the tarball root, so this resolves in the repository and in an install.
 */
const VERSION = (
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf-8")) as {
    version: string;
  }
).version;

/** Collect repeated `--type x` flags, returning them with the positional rest. */
function parseArgs(argv: string[]): {
  positional: string[];
  types: string[];
  includeInline: boolean;
  strict: boolean;
  set: Record<string, string>;
  preset?: string;
  agentFile?: string;
} {
  const positional: string[] = [];
  const types: string[] = [];
  let includeInline = false;
  let strict = false;
  const set: Record<string, string> = {};
  let preset: string | undefined;
  let agentFile: string | undefined;
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
    if (arg === "--strict") {
      strict = true;
      continue;
    }
    if (arg === "--set") {
      // `key=value`, kept as written: the CLI knows no more about a source's
      // options than the core does.
      const pair = argv[++i] ?? "";
      const at = pair.indexOf("=");
      if (at > 0) set[pair.slice(0, at)] = pair.slice(at + 1);
      continue;
    }
    if (arg === "--preset") {
      preset = argv[++i];
      continue;
    }
    if (arg === "--agent-file") {
      agentFile = argv[++i];
      continue;
    }
    if (arg !== undefined) positional.push(arg);
  }
  return { positional, types, includeInline, strict, set, preset, agentFile };
}

export async function run(argv: string[], ctx: CommandContext): Promise<number> {
  const [command, ...rest] = argv;
  const { positional, types, includeInline, strict, set, preset, agentFile } = parseArgs(rest);

  switch (command) {
    case undefined:
    case "help":
    case "--help":
    case "-h":
      ctx.out(USAGE);
      return 0;
    case "--version":
    case "-v":
      ctx.out(VERSION);
      return 0;
    case "init":
      return init(ctx, { preset, agentFile });
    case "reindex":
      return reindex(ctx);
    case "lint":
      return runLint(ctx);
    case "drift":
      return drift(ctx, { strict });
    case "doctor":
      return doctor(ctx);
    case "source":
      if (positional[0] !== "add") {
        ctx.err("Usage: accreta source add <type> <id> [--set key=value]");
        return 1;
      }
      return sourceAdd(ctx, positional[1] ?? "", positional[2] ?? "", set);
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
