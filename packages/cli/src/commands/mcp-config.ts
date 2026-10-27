import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { printable, type CommandContext } from "./shared.ts";

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
  /** The client's own command and its JSON argument, printed instead of writing a file it manages. */
  command?: { prefix: string; json: string };
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

function claudeConfigPath(h: string): string {
  return join(process.env.CLAUDE_CONFIG_DIR || h, ".claude.json");
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

// JSON already doubles every literal backslash, so printable's own doubling is undone.
// Display only: an astral escape such as `\u{e0041}` is not valid JSON.
function printableJson(value: unknown): string {
  return printable(JSON.stringify(value)).replaceAll("\\\\", "\\");
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
        ...at(claudeConfigPath(h)),
        format: "json",
        container: "mcpServers",
        entry,
        command: {
          prefix: `claude mcp add-json --scope user ${SERVER}`,
          json: JSON.stringify(entry),
        },
      };
    }
    case "cursor":
      // No cwd field either; ${workspaceFolder} is the folder that holds .cursor/mcp.json.
      return {
        client,
        scope,
        ...at(join(scope === "project" ? root : h, ".cursor", "mcp.json")),
        // Cursor's docs show comments in it.
        format: "jsonc",
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
        command: { prefix: "code --add-mcp", json: JSON.stringify({ name: SERVER, ...entry }) },
      };
    }
  }
}

function tilde(path: string, h: string): string {
  return path === h || path.startsWith(h + sep) ? `~${path.slice(h.length)}` : path;
}

/** Comments and trailing commas out, strings untouched: VS Code and Cursor read JSONC. */
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

type Readable = Pick<Target, "path" | "format" | "container">;

// smol-toml 1.9 builds tables with a null prototype, which isDeepStrictEqual tells apart.
function readToml(text: string): Record<string, unknown> {
  return JSON.parse(JSON.stringify(parseToml(text))) as Record<string, unknown>;
}

function readTarget(target: Readable, { strict = false } = {}): Read {
  if (!existsSync(target.path)) return { kind: "missing" };
  let text: string;
  try {
    text = readFileSync(target.path, "utf-8");
  } catch (error) {
    return { kind: "broken", reason: (error as Error).message };
  }
  let data: unknown;
  try {
    if (target.format === "toml") data = readToml(text);
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
  if (refuseOutside(ctx, root, target)) return 1;
  const read = readTarget(target, { strict: target.command === undefined });

  if (read.kind === "broken") {
    ctx.err(`${target.shown} does not parse: ${printable(read.reason)}`);
    ctx.err("accreta does not rewrite a file it cannot read. Fix it, or add this by hand:\n");
    ctx.err(snippet(target));
    return 1;
  }
  const current = read.kind === "ok" ? read.servers[SERVER] : undefined;
  if (current !== undefined && isDeepStrictEqual(current, target.entry)) {
    ctx.out(`${target.shown} already starts accreta's server for ${name}. Nothing to do.`);
    warnPath(ctx, root, name);
    return 0;
  }
  if (current !== undefined && !options.force) {
    ctx.err(`${target.shown} already has an \`${SERVER}\` server that differs:`);
    ctx.err(`  current: ${printableJson(current)}`);
    ctx.err(`  install: ${printableJson(target.entry)}`);
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
    const { prefix, json } = target.command;
    if (process.platform === "win32") {
      ctx.out(`${name} adds user-scope servers itself. Run \`${prefix}\` with this JSON as its`);
      ctx.out(`last argument, quoted for your shell:\n\n  ${json}\n`);
    } else {
      ctx.out(`${name} adds user-scope servers itself. Run:\n\n  ${prefix} ${shellQuote(json)}\n`);
    }
    ctx.out(`Then restart ${name}, or reload its MCP servers.`);
    warnPath(ctx, root, name);
    return 0;
  }

  let text: string;
  if (target.format === "toml") {
    const merged = mergeToml(read.kind === "ok" ? read.text : "", target, current !== undefined);
    if ("reason" in merged) {
      ctx.err(`${target.shown}: ${merged.reason}. Add this by hand:\n`);
      ctx.err(snippet(target));
      return 1;
    }
    text = merged.text;
  } else {
    const data = read.kind === "ok" ? read.data : {};
    const servers = read.kind === "ok" ? read.servers : {};
    data[target.container] = { ...servers, [SERVER]: target.entry };
    text = `${JSON.stringify(data, null, read.kind === "ok" ? indentOf(read.text) : 2)}\n`;
  }
  mkdirSync(dirname(target.path), { recursive: true });
  // A symlink could have appeared while the directories were made.
  if (refuseOutside(ctx, root, target)) return 1;
  writeAtomic(target.path, text);

  ctx.out(`${current === undefined ? "Added" : "Replaced"} accreta's server in ${target.shown}.`);
  if (target.client === "codex" && target.scope === "project") {
    ctx.out("Codex reads a project's .codex/config.toml only once you trust the project.");
  }
  ctx.out(`Restart ${name}, or reload its MCP servers, to connect.`);
  warnPath(ctx, root, name);
  return 0;
}

function warnPath(ctx: CommandContext, root: string, name: string): void {
  if (resolves("accreta", root)) return;
  ctx.err(`Warning: \`accreta\` is not on this shell's PATH, so ${name} may not find it either.`);
  ctx.err(
    "Install it globally (`npm install -g accreta`), or change the entry to run `npx -y accreta mcp`.",
  );
}

/** A committed project file is attacker-shaped input: a symlink there could aim the write at ~. */
function refuseOutside(ctx: CommandContext, root: string, target: Target): boolean {
  if (target.scope !== "project") return false;
  const problem = escapesRoot(root, target.path);
  if (!problem) return false;
  ctx.err(`Refusing to write ${target.shown}: ${printable(problem)}.`);
  ctx.err(
    "A project file must stay inside the knowledge base, so install follows no symlink there.",
  );
  return true;
}

function escapesRoot(root: string, path: string): string | null {
  let at = root;
  for (const part of relative(root, path).split(sep)) {
    at = join(at, part);
    let link: boolean;
    try {
      link = lstatSync(at).isSymbolicLink();
    } catch {
      break;
    }
    if (link) return `${relative(root, at)} is a symlink`;
  }
  let dir = dirname(path);
  while (!existsSync(dir) && dir !== dirname(dir)) dir = dirname(dir);
  const real = realpathSync(dir);
  const top = realpathSync(root);
  return real === top || real.startsWith(top + sep)
    ? null
    : `${relative(root, dir)} resolves outside it`;
}

/** The indent the file already uses, so a rewrite changes no more lines than it must. */
function indentOf(text: string): string | number {
  return /\n([ \t]+)\S/.exec(text)?.[1] ?? 2;
}

/**
 * A temp file beside the real file, then a rename, so a crash never leaves half a config. Writing
 * beside a symlink's target keeps the symlink, and copying the mode keeps a 600 file at 600.
 */
function writeAtomic(path: string, text: string): void {
  const real = existsSync(path) ? realpathSync(path) : path;
  const mode = existsSync(real) ? statSync(real).mode & 0o777 : undefined;
  const temp = join(dirname(real), `.${basename(real)}.${process.pid}.${Date.now()}.tmp`);
  try {
    writeFileSync(temp, text, { encoding: "utf-8", flag: "wx", mode: mode ?? 0o666 });
    if (mode !== undefined) chmodSync(temp, mode);
    renameSync(temp, real);
  } catch (error) {
    if (existsSync(temp)) unlinkSync(temp);
    throw error;
  }
}

const TABLE_HEADER =
  /^\s*\[\s*mcp_servers\s*\.\s*(?:accreta|"accreta"|'accreta')\s*(\.[^\]]*)?\]\s*(#.*)?$/;
const ANY_HEADER = /^\s*\[/;
const BLANK_OR_COMMENT = /^\s*(#.*)?$/;
const INLINE_CONTAINER = /^\s*mcp_servers\s*=/m;

/**
 * Append the table, or replace an existing `[mcp_servers.accreta]` in place, leaving every other
 * byte as it was. A reason instead when the result would not read back as exactly that change.
 */
function mergeToml(
  text: string,
  target: Target,
  replace: boolean,
): { text: string } | { reason: string } {
  if (INLINE_CONTAINER.test(text)) {
    return { reason: "`mcp_servers` is an inline table, which accreta cannot add to" };
  }
  const unsafe = {
    reason: `it defines \`${target.container}.${SERVER}\` in a form accreta cannot edit safely`,
  };
  const block = stringifyToml({ [target.container]: { [SERVER]: target.entry } });
  let merged: string;
  if (!replace) {
    const gap = text === "" || text.endsWith("\n\n") ? "" : text.endsWith("\n") ? "\n" : "\n\n";
    merged = `${text}${gap}${block}`;
  } else {
    const lines = text.split("\n");
    const start = lines.findIndex((line) => TABLE_HEADER.test(line));
    if (start === -1) return unsafe;
    let end = start + 1;
    while (end < lines.length) {
      const line = lines[end]!;
      if (ANY_HEADER.test(line) && !TABLE_HEADER.test(line)) break;
      end++;
    }
    // Comments and blank lines just above the next table belong to it, not to accreta's.
    while (end - 1 > start && BLANK_OR_COMMENT.test(lines[end - 1]!)) end--;
    const prefix = lines.slice(0, start).join("\n");
    // `block` ends in the newline that joined the last replaced line to what follows.
    merged = `${prefix === "" ? "" : `${prefix}\n`}${block}${lines.slice(end).join("\n")}`;
  }
  let before: Record<string, unknown>;
  let after: Record<string, unknown>;
  try {
    before = readToml(text);
    after = readToml(merged);
  } catch {
    return unsafe;
  }
  const servers = after[target.container];
  if (!isTable(servers) || !isDeepStrictEqual(servers[SERVER], target.entry)) return unsafe;
  return isDeepStrictEqual(withoutAccreta(before, target), withoutAccreta(after, target))
    ? { text: merged }
    : unsafe;
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

function executable(path: string): boolean {
  try {
    accessSync(path, process.platform === "win32" ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** A directory `npx` or `bun run` put on PATH for this process only; the client will not have it. */
function runnerAdded(dir: string): boolean {
  const parts = dir.split(/[\\/]/);
  return parts.some(
    (part, i) =>
      part === "_npx" ||
      part.startsWith("bun-node-") ||
      (part === ".bin" && parts[i - 1] === "node_modules"),
  );
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
    .filter((dir) => dir !== "" && !runnerAdded(dir))
    .some((dir) => exts.some((ext) => executable(join(dir, command + ext))));
}

// A version or dist-tag only: `accreta@npm:x` or `accreta@github:x/y` installs something else.
const PACKAGE = /^accreta(?:@[\w.^~<>=*+-]+)?$/;

/** Split leading flags from the rest, for runners whose flags we allow by name. */
function runnerForm(args: readonly string[], allowed: readonly string[], required: boolean) {
  const at = args.findIndex((arg) => !arg.startsWith("-"));
  const flags = at === -1 ? args : args.slice(0, at);
  const rest = at === -1 ? [] : args.slice(at);
  if (!flags.every((flag) => allowed.includes(flag))) return false;
  if (required && flags.length === 0) return false;
  return rest.length === 2 && PACKAGE.test(rest[0]!) && rest[1] === "mcp";
}

/** Forms that can only start accreta's own server. */
function knownGood(command: string, args: readonly string[], root: string): boolean {
  const bare = process.platform === "win32" ? command.replace(/\.(cmd|exe)$/i, "") : command;
  if (bare === "accreta") return isDeepStrictEqual(args, ["mcp"]);
  if (bare === "accreta-mcp") return args.length === 0;
  if (bare === "npx") return runnerForm(args, ["-y", "--yes"], true);
  if (bare === "bunx") return runnerForm(args, ["--bun"], false);
  if (!isAbsolute(command) || basename(bare) !== "accreta") return false;
  // A binary inside the knowledge base is whatever its last commit put there.
  const real = existsSync(command) ? realpathSync(command) : command;
  const top = realpathSync(root);
  return !real.startsWith(top + sep) && isDeepStrictEqual(args, ["mcp"]);
}

function mentionsAccreta(name: string, entry: unknown): boolean {
  if (name.includes(SERVER)) return true;
  if (!isTable(entry)) return false;
  return [entry.command, ...(Array.isArray(entry.args) ? entry.args : [])].some(
    (part) => typeof part === "string" && part.includes(SERVER),
  );
}

type DoctorScope = Scope | "local";

/**
 * Every location `mcp install` writes, and Claude Code's local scope, read-only. True when one is
 * broken: a file that does not parse, a command that is not there, or a path that no longer ships.
 */
export function reportMcp(ctx: CommandContext, root: string): boolean {
  ctx.out("\nmcp");
  let broken = false;
  let found = 0;
  const seen = new Set<string>();
  const check = (
    label: string,
    servers: Record<string, unknown>,
    client: Client,
    scope: DoctorScope,
  ) => {
    for (const [name, entry] of Object.entries(servers)) {
      if (!mentionsAccreta(name, entry)) continue;
      found++;
      if (checkEntry(ctx, { label, name, entry, client, scope, root })) broken = true;
    }
  };
  for (const client of CLIENTS) {
    for (const scope of SCOPES) {
      const target = targetFor(client, scope, root);
      // A knowledge base at the home directory would otherwise report each file twice.
      if (seen.has(target.path)) continue;
      seen.add(target.path);
      const read = readTarget(target);
      if (read.kind === "missing") continue;
      const label = `${printable(target.shown)} (${NAMES[client]}, ${scope})`;
      if (read.kind === "broken") {
        ctx.out(`  broken: ${label} does not parse — ${printable(read.reason)}`);
        ctx.out(`    → fix it, then re-run \`${installCommand(client, scope)}\``);
        broken = true;
        found++;
        continue;
      }
      check(label, read.servers, client, scope);
    }
  }
  // Where `claude mcp add` puts a server by default: keyed by project in the user file.
  const user = targetFor("claude", "user", root);
  const read = readTarget(user);
  if (read.kind === "ok" && isTable(read.data.projects)) {
    const projects = read.data.projects;
    const keys = new Set([resolve(root), realpathSync(root)]);
    for (const key of keys) {
      const project = projects[key];
      if (!isTable(project) || !isTable(project.mcpServers)) continue;
      check(`${printable(user.shown)} (Claude Code, local)`, project.mcpServers, "claude", "local");
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

function installCommand(client: Client, scope: Scope): string {
  return `accreta mcp install --client ${client}${scope === "user" ? " --scope user" : ""}`;
}

interface Found {
  label: string;
  name: string;
  entry: unknown;
  client: Client;
  scope: DoctorScope;
  root: string;
}

function checkEntry(ctx: CommandContext, found: Found): boolean {
  const { entry, client, scope, root } = found;
  const label = `${found.label} \`${printable(found.name)}\``;
  // The name is pasted into a shell, so only one no shell would split or read as a flag is offered.
  const remove = /^[\w.][\w.-]*$/.test(found.name)
    ? `run \`claude mcp remove --scope local ${found.name}\``
    : `remove \`${printable(found.name)}\` from ${printable(targetFor("claude", "user", root).shown)} by hand`;
  const reinstall =
    scope === "local"
      ? `${remove}, then \`${installCommand(client, "project")}\``
      : `re-run \`${installCommand(client, scope)} --force\``;
  const command = isTable(entry) && typeof entry.command === "string" ? entry.command : undefined;
  const args =
    isTable(entry) && Array.isArray(entry.args)
      ? entry.args.filter((arg): arg is string => typeof arg === "string")
      : [];
  if (command === undefined) {
    ctx.out(`  unknown: ${label} has no \`command\` — not a stdio server doctor can check`);
    return false;
  }
  const shown = printable([command, ...args].join(" "));
  if (args.some((arg) => arg.replaceAll("\\", "/").includes(STALE_SERVER))) {
    ctx.out(`  stale: ${label} runs \`${shown}\`, a path that no longer ships`);
    ctx.out(`    → ${reinstall}`);
    return true;
  }
  if (!resolves(command, root)) {
    ctx.out(`  broken: ${label} runs \`${printable(command)}\`, which is not on this shell's PATH`);
    ctx.out(
      "    → install accreta where the client can find it (`npm install -g accreta`), or run `npx -y accreta mcp`",
    );
    return true;
  }
  if (!knownGood(command, args, root)) {
    ctx.out(`  unknown: ${label} runs \`${shown}\`, not a form doctor knows`);
    ctx.out(`    → ${reinstall}`);
    return false;
  }
  const elsewhere = servesElsewhere(entry, root);
  if (elsewhere) {
    ctx.out(`  ok: ${label} runs \`${shown}\`, for the knowledge base at ${printable(elsewhere)}`);
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
