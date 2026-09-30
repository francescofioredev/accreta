#!/usr/bin/env bun
import { readFileSync } from "node:fs";

import {
  COMMAND_ARGS,
  refuseArguments,
  type CommandContext,
  type ParsedArgs,
} from "./commands/shared.ts";
import { canonical } from "./commands/canonical.ts";
import { cite } from "./commands/cite.ts";
import { consumers } from "./commands/consumers.ts";
import { doctor } from "./commands/doctor.ts";
import { drift } from "./commands/drift.ts";
import { init } from "./commands/init.ts";
import { runLint } from "./commands/lint.ts";
import { mcp } from "./commands/mcp.ts";
import { reindex } from "./commands/reindex.ts";
import { search } from "./commands/search.ts";
import { show } from "./commands/show.ts";
import { sourceAdd } from "./commands/source.ts";

const USAGE = `accreta — a knowledge base an agent writes and keeps current

Usage: accreta <command> [arguments]

  init [--preset <name>]   Create accreta.config.yaml, knowledge/, sources/ and
                           a constitution. Presets: codebase, research.
                           --agent-file <name> names the constitution (default AGENTS.md)
  reindex                  Rebuild the index from the knowledge base
  lint                     Report unresolvable links, missing provenance, unknown types
  drift [--strict]         Report which pages their sources have moved out from under.
                           --strict also fails on anything left unchecked
  doctor                   Report what is wired up, and what cannot be checked from here
  source add <type> <id>   Write a source declaration (--set key=value, repeatable)
  search <query>           Full-text search (--type <type>, repeatable; --source <id>;
                           --limit <n>, 1-50, default 20)
  show <path|wikilink>     Print a page
  consumers <path>         What links to this page, and what it links to (--inline;
                           --kind <field>, repeatable)
  canonical <term>         Resolve a term to the page that defines it
  cite <source>:<path>[#locator]
                           The citation for a claim, at the source's current revision.
                           Before reading, cite the file and keep its revision; after
                           writing, cite the place with --expect-revision <rev>, which
                           fails if the source has moved since

  --json                   On lint, search, show, consumers, canonical and cite: print
                           the JSON the matching MCP tool returns
  --limit <n>, --cursor <c>
                           On lint, consumers and canonical: print one page of at most
                           n results (1-50, default 50), then the page the cursor names

  --version, -v            Print the version
  --help, -h               Print this usage, after any command too
  --                       End of options: every later argument is positional

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
function parseArgs(argv: string[]): ParsedArgs & {
  help: boolean;
  types: string[];
  kinds: string[];
  includeInline: boolean;
  strict: boolean;
  json: boolean;
  limit?: string;
  cursor?: string;
  source?: string;
  set: Record<string, string>;
  preset?: string;
  agentFile?: string;
  expectRevision?: string;
} {
  const positional: string[] = [];
  const flags: string[] = [];
  const afterEndOfOptions: string[] = [];
  const problems: string[] = [];
  let help = false;
  let endOfOptions = false;
  const types: string[] = [];
  const kinds: string[] = [];
  let includeInline = false;
  let strict = false;
  let json = false;
  let limit: string | undefined;
  let cursor: string | undefined;
  let source: string | undefined;
  const set: Record<string, string> = {};
  let preset: string | undefined;
  let agentFile: string | undefined;
  let expectRevision: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    let arg = argv[i];
    if (arg === undefined) continue;
    if (endOfOptions) {
      positional.push(arg);
      afterEndOfOptions.push(arg);
      continue;
    }
    if (arg === "--") {
      endOfOptions = true;
      continue;
    }
    if (["-h", "--help"].includes(arg)) {
      help = true;
      continue;
    }
    let inline: string | undefined;
    if (arg.startsWith("--") && arg.includes("=")) {
      inline = arg.slice(arg.indexOf("=") + 1);
      arg = arg.slice(0, arg.indexOf("="));
    }
    const name = arg;
    // Never swallow the next flag as a value: `--source --json` once searched source "--json".
    const value = (): string | undefined => {
      const next = inline ?? argv[i + 1];
      if (next === undefined || next === "" || next.startsWith("--")) {
        problems.push(`${name} needs a value.`);
        return undefined;
      }
      if (inline === undefined) i++;
      return next;
    };
    const flag = (): boolean => {
      if (inline !== undefined) problems.push(`${name} takes no value.`);
      return true;
    };
    if (arg.startsWith("-") && arg !== "-") flags.push(arg === "-t" ? "--type" : arg);

    if (arg === "--type" || arg === "-t") {
      const type = value();
      if (type) types.push(type);
      continue;
    }
    if (arg === "--kind") {
      const kind = value();
      if (kind) kinds.push(kind);
      continue;
    }
    if (arg === "--inline") {
      includeInline = flag();
      continue;
    }
    if (arg === "--strict") {
      strict = flag();
      continue;
    }
    if (arg === "--json") {
      json = flag();
      continue;
    }
    if (arg === "--limit") {
      limit = value();
      continue;
    }
    if (arg === "--cursor") {
      cursor = value();
      continue;
    }
    if (arg === "--source") {
      source = value();
      continue;
    }
    if (arg === "--set") {
      // `key=value`, kept as written: the CLI knows no more about a source's
      // options than the core does.
      const pair = value();
      const at = pair?.indexOf("=") ?? -1;
      if (pair && at > 0) set[pair.slice(0, at)] = pair.slice(at + 1);
      else if (pair) problems.push("--set takes key=value.");
      continue;
    }
    if (arg === "--preset") {
      preset = value();
      continue;
    }
    if (arg === "--agent-file") {
      agentFile = value();
      continue;
    }
    if (arg === "--expect-revision") {
      expectRevision = value();
      continue;
    }
    if (!arg.startsWith("-") || arg === "-") positional.push(arg);
  }
  return {
    positional,
    flags,
    afterEndOfOptions,
    problems,
    help,
    types,
    kinds,
    includeInline,
    strict,
    json,
    limit,
    cursor,
    source,
    set,
    preset,
    agentFile,
    expectRevision,
  };
}

export async function run(argv: string[], ctx: CommandContext): Promise<number> {
  const [command, ...rest] = argv;
  const parsed = parseArgs(rest);
  const { positional, types, kinds, includeInline, strict, json, limit, cursor, source, set } =
    parsed;
  const { preset, agentFile } = parsed;

  // Only a command this install has: `cite --help` on an older one must not look like success.
  if (parsed.help && command !== undefined && Object.hasOwn(COMMAND_ARGS, command)) {
    ctx.out(USAGE);
    return 0;
  }
  const refusal = refuseArguments(command, parsed);
  if (refusal) {
    ctx.err(refusal);
    return 2;
  }

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
      return runLint(ctx, { json, limit, cursor });
    case "drift":
      return drift(ctx, rest, strict);
    case "doctor":
      return doctor(ctx, VERSION);
    case "source":
      if (positional[0] !== "add") {
        ctx.err("Usage: accreta source add <type> <id> [--set key=value]");
        return 2;
      }
      return sourceAdd(ctx, positional[1] ?? "", positional[2] ?? "", set);
    case "search":
      return search(ctx, positional.join(" "), {
        types: types.length > 0 ? types : undefined,
        source,
        limit,
        json,
      });
    case "show":
      return show(ctx, positional[0] ?? "", { json });
    case "consumers":
      return consumers(ctx, positional[0] ?? "", {
        includeInline,
        kinds: kinds.length > 0 ? kinds : undefined,
        json,
        limit,
        cursor,
      });
    case "canonical":
      return canonical(ctx, positional.join(" "), { json, limit, cursor });
    case "cite":
      return cite(ctx, positional[0] ?? "", { json, expectRevision: parsed.expectRevision });
    case "mcp":
      return mcp(ctx, positional);
    default:
      ctx.err(`Unknown command "${command}".\n`);
      ctx.err(USAGE);
      return 2;
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
