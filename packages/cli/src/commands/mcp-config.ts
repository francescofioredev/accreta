import { accessSync, constants, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import type { CommandContext } from "./shared.ts";

export const CLIENTS = ["claude", "cursor", "codex", "vscode"] as const;
export const SCOPES = ["project", "user"] as const;
export type Client = (typeof CLIENTS)[number];
export type Scope = (typeof SCOPES)[number];

const SERVER = "accreta";
const NAMES: Record<Client, string> = {
  claude: "Claude Code",
  cursor: "Cursor",
  codex: "Codex",
  vscode: "VS Code",
};

type Entry = Record<string, unknown>;

/** One place a client reads its MCP servers from, and the accreta entry install puts there. */
export interface Target {
  client: Client;
  scope: Scope;
  path: string;
  /** The path as printed: relative to the knowledge base, or under `~`. */
  shown: string;
  format: "json" | "jsonc" | "toml";
  container: "mcpServers" | "servers" | "mcp_servers";
  entry: Entry;
  /** The client's own command, printed instead of writing a file it manages itself. */
  command?: string;
}

// Bun caches homedir() at startup; tests and Node read HOME as it is now.
function home(): string {
  return process.env.HOME || homedir();
}

function vscodeUserDir(h: string): string {
  if (process.platform === "darwin")
    return join(h, "Library", "Application Support", "Code", "User");
  if (process.platform === "win32") {
    return join(process.env.APPDATA || join(h, "AppData", "Roaming"), "Code", "User");
  }
  return join(process.env.XDG_CONFIG_HOME || join(h, ".config"), "Code", "User");
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

const RUN = { command: "accreta", args: ["mcp"] };

/**
 * Project files carry no absolute path, since they get committed; each starts the server inside
 * the knowledge base its own way. User files name the knowledge base, which is the point of them.
 */
export function targetFor(client: Client, scope: Scope, root: string): Target {
  const h = home();
  const at = (path: string) => ({
    path,
    shown: scope === "project" ? relative(root, path) : tilde(path, h),
  });
  switch (client) {
    case "claude": {
      // No cwd field: Claude Code starts the server in the project, and accreta searches upward.
      if (scope === "project") {
        return {
          client,
          scope,
          ...at(join(root, ".mcp.json")),
          format: "json",
          container: "mcpServers",
          entry: { type: "stdio", ...RUN },
        };
      }
      const entry = { type: "stdio", ...RUN, env: { ACCRETA_ROOT: root } };
      return {
        client,
        scope,
        ...at(join(process.env.CLAUDE_CONFIG_DIR || h, ".claude.json")),
        format: "json",
        container: "mcpServers",
        entry,
        command: `claude mcp add-json --scope user ${SERVER} ${shellQuote(JSON.stringify(entry))}`,
      };
    }
    case "cursor":
      // No cwd field either; ${workspaceFolder} is the folder that holds .cursor/mcp.json.
      return {
        client,
        scope,
        ...at(join(scope === "project" ? root : h, ".cursor", "mcp.json")),
        format: "json",
        container: "mcpServers",
        entry: {
          type: "stdio",
          ...RUN,
          env: { ACCRETA_ROOT: scope === "project" ? "${workspaceFolder}" : root },
        },
      };
    case "codex":
      return {
        client,
        scope,
        ...at(
          scope === "project"
            ? join(root, ".codex", "config.toml")
            : join(process.env.CODEX_HOME || join(h, ".codex"), "config.toml"),
        ),
        format: "toml",
        container: "mcp_servers",
        entry: scope === "project" ? { ...RUN } : { ...RUN, cwd: root },
      };
    case "vscode": {
      if (scope === "project") {
        return {
          client,
          scope,
          ...at(join(root, ".vscode", "mcp.json")),
          format: "jsonc",
          container: "servers",
          entry: { type: "stdio", ...RUN, cwd: "${workspaceFolder}" },
        };
      }
      const entry = { type: "stdio", ...RUN, cwd: root };
      return {
        client,
        scope,
        ...at(join(vscodeUserDir(h), "mcp.json")),
        format: "jsonc",
        container: "servers",
        entry,
        command: `code --add-mcp ${shellQuote(JSON.stringify({ name: SERVER, ...entry }))}`,
      };
    }
  }
}

function tilde(path: string, h: string): string {
  return path === h || path.startsWith(h + sep) ? `~${path.slice(h.length)}` : path;
}

/** Comments and trailing commas out, strings untouched: VS Code reads its mcp.json as JSONC. */
export function stripJsonc(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === '"') {
      const start = i;
      for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === "\\") i++;
      out += text.slice(start, i + 1);
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end === -1 ? text.length : end + 1;
    } else {
      out += c;
    }
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

type Read =
  | { kind: "missing" }
  | { kind: "broken"; reason: string }
  | { kind: "ok"; text: string; data: Record<string, unknown>; servers: Record<string, unknown> };

function isTable(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readTarget(target: Target, { strict = false } = {}): Read {
  if (!existsSync(target.path)) return { kind: "missing" };
  let text: string;
  try {
    text = readFileSync(target.path, "utf-8");
  } catch (error) {
    return { kind: "broken", reason: (error as Error).message };
  }
  let data: unknown;
  try {
    if (target.format === "toml") data = parseToml(text);
    else if (target.format === "json" || strict) data = JSON.parse(text);
    else data = JSON.parse(stripJsonc(text));
  } catch (error) {
    const jsonc = target.format === "jsonc" && strict;
    const reason = (error as Error).message.split("\n")[0]!;
    return {
      kind: "broken",
      reason: jsonc
        ? `${reason} (comments and trailing commas would be lost by a rewrite)`
        : reason,
    };
  }
  if (!isTable(data)) return { kind: "broken", reason: "the top level is not an object" };
  const servers = data[target.container] ?? {};
  if (!isTable(servers))
    return { kind: "broken", reason: `\`${target.container}\` is not an object` };
  return { kind: "ok", text, data, servers };
}

function snippet(target: Target): string {
  if (target.format === "toml")
    return stringifyToml({ [target.container]: { [SERVER]: target.entry } });
  return JSON.stringify({ [target.container]: { [SERVER]: target.entry } }, null, 2);
}

export interface InstallOptions {
  client: Client;
  scope: Scope;
  force: boolean;
}

/** Merge accreta's entry into the client's file; never clobber another server or an unreadable file. */
export function install(ctx: CommandContext, root: string, options: InstallOptions): number {
  const target = targetFor(options.client, options.scope, root);
  const name = NAMES[target.client];
  const read = readTarget(target, { strict: target.command === undefined });

  if (read.kind === "broken") {
    ctx.err(`${target.shown} does not parse: ${read.reason}`);
    ctx.err("accreta does not rewrite a file it cannot read. Fix it, or add this by hand:\n");
    ctx.err(snippet(target));
    return 1;
  }
  const current = read.kind === "ok" ? read.servers[SERVER] : undefined;
  if (current !== undefined && isDeepStrictEqual(current, target.entry)) {
    ctx.out(`${target.shown} already starts accreta's server for ${name}. Nothing to do.`);
    return 0;
  }
  if (current !== undefined && !options.force) {
    ctx.err(`${target.shown} already has an \`${SERVER}\` server that differs:`);
    ctx.err(`  current: ${JSON.stringify(current)}`);
    ctx.err(`  install: ${JSON.stringify(target.entry)}`);
    ctx.err("Re-run with --force to replace it.");
    return 1;
  }

  if (target.command) {
    // A file the client manages itself: its own command keeps whatever it tracks alongside.
    if (current !== undefined) {
      const remove =
        target.client === "claude"
          ? `claude mcp remove --scope user ${SERVER}`
          : "MCP: Open User Configuration, and delete the accreta entry";
      ctx.out(`First remove the current entry: ${remove}`);
    }
    ctx.out(`${name} adds user-scope servers itself. Run:\n\n  ${target.command}\n`);
    ctx.out(`Then restart ${name}, or reload its MCP servers.`);
    return 0;
  }

  let text: string;
  if (target.format === "toml") {
    const merged = mergeToml(read.kind === "ok" ? read.text : "", target, current !== undefined);
    if (merged === null) {
      ctx.err(
        `${target.shown} defines \`${target.container}.${SERVER}\` in a form accreta cannot edit safely.`,
      );
      ctx.err("Replace it by hand with:\n");
      ctx.err(snippet(target));
      return 1;
    }
    text = merged;
  } else {
    const data = read.kind === "ok" ? read.data : {};
    const servers = read.kind === "ok" ? read.servers : {};
    data[target.container] = { ...servers, [SERVER]: target.entry };
    text = `${JSON.stringify(data, null, 2)}\n`;
  }
  mkdirSync(dirname(target.path), { recursive: true });
  writeFileSync(target.path, text, "utf-8");

  ctx.out(`${current === undefined ? "Added" : "Replaced"} accreta's server in ${target.shown}.`);
  if (target.client === "codex" && target.scope === "project") {
    ctx.out("Codex reads a project's .codex/config.toml only once you trust the project.");
  }
  ctx.out(`Restart ${name}, or reload its MCP servers, to connect.`);
  return 0;
}

const TABLE_HEADER =
  /^\s*\[\s*mcp_servers\s*\.\s*(?:accreta|"accreta"|'accreta')\s*(\.[^\]]*)?\]\s*(#.*)?$/;
const ANY_HEADER = /^\s*\[/;

/**
 * Append the table, or replace an existing `[mcp_servers.accreta]` in place, leaving every other
 * byte as it was. Null when the result would not read back as exactly that change.
 */
function mergeToml(text: string, target: Target, replace: boolean): string | null {
  const block = stringifyToml({ [target.container]: { [SERVER]: target.entry } });
  let merged: string;
  if (!replace) {
    const gap = text === "" || text.endsWith("\n\n") ? "" : text.endsWith("\n") ? "\n" : "\n\n";
    merged = `${text}${gap}${block}`;
  } else {
    const lines = text.split("\n");
    const start = lines.findIndex((line) => TABLE_HEADER.test(line));
    if (start === -1) return null;
    let end = start + 1;
    while (end < lines.length) {
      const line = lines[end]!;
      if (ANY_HEADER.test(line) && !TABLE_HEADER.test(line)) break;
      end++;
    }
    const prefix = lines.slice(0, start).join("\n");
    const rest = lines.slice(end).join("\n");
    merged = `${prefix === "" ? "" : `${prefix}\n`}${block}${rest === "" ? "" : `\n${rest}`}`;
  }
  let before: Record<string, unknown>;
  let after: Record<string, unknown>;
  try {
    before = parseToml(text) as Record<string, unknown>;
    after = parseToml(merged) as Record<string, unknown>;
  } catch {
    return null;
  }
  const servers = after[target.container];
  if (!isTable(servers) || !isDeepStrictEqual(servers[SERVER], target.entry)) return null;
  return isDeepStrictEqual(withoutAccreta(before, target), withoutAccreta(after, target))
    ? merged
    : null;
}

function withoutAccreta(data: Record<string, unknown>, target: Target): Record<string, unknown> {
  const servers = data[target.container];
  if (!isTable(servers)) return data;
  const { [SERVER]: _, ...others } = servers;
  const { [target.container]: __, ...rest } = data;
  // Appending the first server creates the container, which is no change to anything else.
  return Object.keys(others).length === 0 ? rest : { ...rest, [target.container]: others };
}

const STALE_SERVER = "node_modules/@accreta/mcp-server/src/main.ts";
const RUNNERS = new Set(["npx", "bunx", "pnpx"]);

function executable(path: string): boolean {
  try {
    accessSync(path, process.platform === "win32" ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Whether `command` names an executable the way the client would look it up. */
function resolves(command: string, base: string): boolean {
  if (isAbsolute(command) || command.includes("/") || command.includes("\\")) {
    return executable(resolve(base, command));
  }
  const exts =
    process.platform === "win32"
      ? ["", ...(process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";")]
      : [""];
  return (process.env.PATH ?? "")
    .split(delimiter)
    .filter(Boolean)
    .some((dir) => exts.some((ext) => executable(join(dir, command + ext))));
}

/** `accreta mcp`, the server's own bin, or either through a package runner. */
function knownGood(command: string, args: readonly string[]): boolean {
  const bare = command
    .split(/[\\/]/)
    .at(-1)!
    .replace(/\.(cmd|exe)$/i, "");
  if (bare === "accreta") return isDeepStrictEqual(args, ["mcp"]);
  if (bare === "accreta-mcp") return args.length === 0;
  if (!RUNNERS.has(bare)) return false;
  const [pkg, ...rest] = args.filter((arg) => !arg.startsWith("-"));
  const name = pkg?.replace(/(.)@.*$/, "$1");
  return (
    (name === "accreta" && isDeepStrictEqual(rest, ["mcp"])) ||
    (name === "@accreta/mcp-server" && rest.length === 0)
  );
}

function mentionsAccreta(name: string, entry: unknown): boolean {
  if (name.includes(SERVER)) return true;
  if (!isTable(entry)) return false;
  return [entry.command, ...(Array.isArray(entry.args) ? entry.args : [])].some(
    (part) => typeof part === "string" && part.includes(SERVER),
  );
}

/**
 * Every location `mcp install` writes, read-only. True when one is broken: a file that does not
 * parse, a command that is not there, or a server path that no longer ships.
 */
export function reportMcp(ctx: CommandContext, root: string): boolean {
  ctx.out("\nmcp");
  let broken = false;
  let found = 0;
  const seen = new Set<string>();
  for (const client of CLIENTS) {
    for (const scope of SCOPES) {
      const target = targetFor(client, scope, root);
      // A knowledge base at the home directory would otherwise report each file twice.
      if (seen.has(target.path)) continue;
      seen.add(target.path);
      const read = readTarget(target);
      if (read.kind === "missing") continue;
      const label = `${target.shown} (${NAMES[client]}, ${scope})`;
      if (read.kind === "broken") {
        ctx.out(`  broken: ${label} does not parse — ${read.reason}`);
        ctx.out(
          `    → fix it, then re-run \`accreta mcp install --client ${client}${scope === "user" ? " --scope user" : ""}\``,
        );
        broken = true;
        found++;
        continue;
      }
      for (const [name, entry] of Object.entries(read.servers)) {
        if (!mentionsAccreta(name, entry)) continue;
        found++;
        if (checkEntry(ctx, `${label} \`${name}\``, entry, client, scope, root)) broken = true;
      }
    }
  }
  if (found === 0) {
    ctx.out(
      "  unknown: no client config here or in your home directory names accreta's server — the agent may be configured elsewhere",
    );
    ctx.out("    → `accreta mcp install --client claude|cursor|codex|vscode`");
  }
  return broken;
}

function checkEntry(
  ctx: CommandContext,
  label: string,
  entry: unknown,
  client: Client,
  scope: Scope,
  root: string,
): boolean {
  const reinstall = `re-run \`accreta mcp install --client ${client}${scope === "user" ? " --scope user" : ""} --force\``;
  const command = isTable(entry) && typeof entry.command === "string" ? entry.command : undefined;
  const args =
    isTable(entry) && Array.isArray(entry.args)
      ? entry.args.filter((arg): arg is string => typeof arg === "string")
      : [];
  if (command === undefined) {
    ctx.out(`  unknown: ${label} has no \`command\` — not a stdio server doctor can check`);
    return false;
  }
  const shown = [command, ...args].join(" ");
  if (args.some((arg) => arg.replaceAll("\\", "/").includes(STALE_SERVER))) {
    ctx.out(`  stale: ${label} runs \`${shown}\`, a path that no longer ships`);
    ctx.out(`    → ${reinstall}`);
    return true;
  }
  if (!resolves(command, root)) {
    ctx.out(`  broken: ${label} runs \`${command}\`, which is not on this shell's PATH`);
    ctx.out(
      "    → install accreta where the client can find it (`npm install -g accreta`), or name its full path",
    );
    return true;
  }
  if (!knownGood(command, args)) {
    ctx.out(`  unknown: ${label} runs \`${shown}\`, not a form doctor knows`);
    ctx.out(`    → ${reinstall}`);
    return false;
  }
  const elsewhere = servesElsewhere(entry, root);
  if (elsewhere) {
    ctx.out(`  ok: ${label} runs \`${shown}\`, for the knowledge base at ${elsewhere}`);
    return false;
  }
  ctx.out(`  ok: ${label} runs \`${shown}\``);
  return false;
}

/** The other knowledge base a user-scope entry names, if it names one by absolute path. */
function servesElsewhere(entry: unknown, root: string): string | undefined {
  if (!isTable(entry)) return undefined;
  const env = isTable(entry.env) ? entry.env : {};
  const named = [env.ACCRETA_ROOT, entry.cwd].find(
    (value): value is string => typeof value === "string" && isAbsolute(value),
  );
  return named !== undefined && resolve(named) !== resolve(root) ? named : undefined;
}
