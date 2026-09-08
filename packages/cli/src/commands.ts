import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildIndex,
  detectDrift,
  findCanonical,
  findRelated,
  getPage,
  lint,
  lintCitations,
  checkConfig,
  DEFAULT_CONFIG,
  openIndex,
  parseSourceDeclaration,
  searchPages,
  type SourceAdapter,
} from "@accreta/core";
import {
  KNOWN_TYPES,
  kindFor,
  loadSources as loadDeclaredSources,
  readDeclarations,
  type Preflight,
} from "@accreta/adapters";
import { CONFIG_FILENAME, findWorkspace, indexPathFor, type Workspace } from "./workspace.ts";
import { composeConstitution, isPreset, PRESETS, type Preset } from "./constitution.ts";

export interface CommandContext {
  cwd: string;
  out: (line: string) => void;
  err: (line: string) => void;
}

/** Load every `sources/*.yaml` declaration in the workspace. */
function loadSources(workspace: Workspace): SourceAdapter[] {
  return [
    ...loadDeclaredSources({
      root: workspace.root,
      citationFormat: workspace.config.provenanceFormat,
    }).values(),
  ];
}

function configTemplateFor(preset?: Preset): string {
  if (preset === "codebase") return CONFIG_CODEBASE;
  if (preset === "research") return CONFIG_RESEARCH;
  return CONFIG_TEMPLATE;
}

const CONFIG_CODEBASE = `# The vocabulary of this knowledge base — the "codebase" preset.

knowledge_base: knowledge

page_types:
  - repository
  - module
  - api
  - usecase
  - concept
  - decision
  - integration
  - synthesis

link_fields:
  - consumers
  - consumed_by
  - delegates_to
  - implements
  - supersedes
  - superseded_by
  - related
  - discussed_in

provenance:
  format: "{source} @ {rev} · {path}#{locator}"
`;

const CONFIG_RESEARCH = `# The vocabulary of this knowledge base — the "research" preset.

knowledge_base: knowledge

page_types:
  - source
  - concept
  - finding
  - method
  - contradiction
  - synthesis

link_fields:
  - cites
  - cited_by
  - supports
  - contradicts
  - supersedes
  - superseded_by
  - related
  - discussed_in

provenance:
  format: "{source} @ {rev} · {path}#{locator}"
`;

const CONFIG_TEMPLATE = `# The vocabulary of this knowledge base.
#
# Page types and link fields live here rather than in the code, so a knowledge
# base about any subject can describe itself in its own terms.

knowledge_base: knowledge

page_types:
  - note
  - source
  - concept
  - decision
  - synthesis

link_fields:
  - related
  - supersedes
  - superseded_by
  - discussed_in

provenance:
  format: "{source} @ {rev} · {path}#{locator}"
`;

export interface InitOptions {
  preset?: string;
  /** Filename for the generated constitution. */
  agentFile?: string;
}

export function init(ctx: CommandContext, options: InitOptions = {}): number {
  const root = ctx.cwd;
  const configPath = join(root, CONFIG_FILENAME);

  if (existsSync(configPath)) {
    ctx.err(`${CONFIG_FILENAME} already exists. Leaving it alone.`);
    return 1;
  }

  let preset: Preset | undefined;
  if (options.preset !== undefined) {
    if (!isPreset(options.preset)) {
      ctx.err(`Unknown preset "${options.preset}". Available: ${PRESETS.join(", ")}.`);
      return 1;
    }
    preset = options.preset;
  }

  writeFileSync(configPath, configTemplateFor(preset), "utf-8");
  mkdirSync(join(root, "knowledge"), { recursive: true });
  mkdirSync(join(root, "sources"), { recursive: true });

  const examplePath = join(root, "sources", "example.yaml");
  if (!existsSync(examplePath))
    writeFileSync(examplePath, kindFor("fs")!.template("example"), "utf-8");

  // The constitution is written only if nothing is there to overwrite. An
  // existing AGENTS.md or CLAUDE.md is somebody's work, and init is not the
  // place to discover that the hard way.
  const agentFile = options.agentFile ?? "AGENTS.md";
  const agentPath = join(root, agentFile);
  if (existsSync(agentPath)) {
    ctx.err(`${agentFile} already exists. Not overwriting it.`);
    ctx.err(`The composed constitution would have gone there; write it by hand if you want it.`);
  } else {
    writeFileSync(agentPath, composeConstitution({ preset, filename: agentFile }), "utf-8");
  }

  ctx.out(`Created ${CONFIG_FILENAME}, knowledge/, sources/ and ${agentFile}.`);
  if (preset) ctx.out(`Vocabulary and constitution use the "${preset}" preset.`);
  ctx.out("Describe a source in sources/, then run `accreta reindex`.");
  return 0;
}

export function reindex(ctx: CommandContext): number {
  const workspace = findWorkspace(ctx.cwd);
  const result = buildIndex({
    root: workspace.root,
    config: workspace.config,
    indexPath: workspace.indexPath,
  });

  ctx.out(
    `Indexed ${result.pages} page${result.pages === 1 ? "" : "s"} ` +
      `and ${result.links} link${result.links === 1 ? "" : "s"} in ${result.ms.toFixed(0)}ms.`,
  );
  if (result.brokenLinks > 0) {
    // Surfaced here rather than left for `lint`, because a rebuild is when
    // someone is looking.
    ctx.out(`${result.brokenLinks} link(s) did not resolve. Run \`accreta lint\` for detail.`);
  }
  return 0;
}

function withIndex<T>(
  ctx: CommandContext,
  fn: (db: ReturnType<typeof openIndex>, w: Workspace) => T,
): T {
  const workspace = findWorkspace(ctx.cwd);
  if (!existsSync(workspace.indexPath)) {
    throw new Error(`No index at ${workspace.indexPath}. Run \`accreta reindex\` first.`);
  }
  const db = openIndex(workspace.indexPath, { readonly: true });
  try {
    return fn(db, workspace);
  } finally {
    db.close();
  }
}

// Opens and closes the index itself rather than going through `withIndex`:
// citation checks read from the sources, and `withIndex` closes the database in
// a synchronous `finally` that would fire before the first await resolved.
// `drift` has the same shape for the same reason.
export async function runLint(ctx: CommandContext): Promise<number> {
  const workspace = findWorkspace(ctx.cwd);
  if (!existsSync(workspace.indexPath)) {
    throw new Error(`No index at ${workspace.indexPath}. Run \`accreta reindex\` first.`);
  }

  const db = openIndex(workspace.indexPath, { readonly: true });
  try {
    const report = lint(db, workspace.config);

    const sources = new Map(loadSources(workspace).map((adapter) => [adapter.id, adapter]));
    const citations = await lintCitations(db, sources);
    const findings = [...report.findings, ...citations.findings];

    // A count rather than findings: the citations belong to a source accreta
    // cannot question, and "I did not look" must not be printed as a problem
    // found. It is still the size of what this pass did not cover.
    const unchecked =
      citations.citationsUnchecked > 0
        ? `${citations.citationsUnchecked} citation(s) could not be checked: ` +
          `their source is one only the agent can read.`
        : null;

    if (findings.length === 0) {
      ctx.out(`${report.pagesChecked} page(s) checked, nothing to report.`);
      if (unchecked) ctx.out(unchecked);
      return 0;
    }

    const byKind = new Map<string, typeof findings>();
    for (const finding of findings) {
      const list = byKind.get(finding.kind);
      if (list) list.push(finding);
      else byKind.set(finding.kind, [finding]);
    }

    for (const [kind, group] of byKind) {
      ctx.out(`\n${kind} (${group.length})`);
      for (const finding of group) ctx.out(`  ${finding.path}: ${finding.detail}`);
    }
    ctx.out(`\n${findings.length} finding(s) across ${report.pagesChecked} page(s).`);
    if (unchecked) ctx.out(unchecked);

    // A non-zero exit so CI can fail on an unresolvable link.
    return 1;
  } finally {
    db.close();
  }
}

export function search(ctx: CommandContext, query: string, types?: string[]): number {
  if (!query) {
    ctx.err("Usage: accreta search <query> [--type <type>]");
    return 1;
  }
  return withIndex(ctx, (db) => {
    const hits = searchPages(db, { query, types });
    if (hits.length === 0) {
      ctx.out("No matches.");
      return 0;
    }
    for (const hit of hits) {
      ctx.out(`${hit.path}  [${hit.type}]`);
      ctx.out(`  ${hit.title}`);
      ctx.out(`  ${hit.snippet.replace(/\s+/g, " ").trim()}`);
    }
    ctx.out(`\n${hits.length} result(s).`);
    return 0;
  });
}

export function show(ctx: CommandContext, target: string): number {
  if (!target) {
    ctx.err("Usage: accreta show <path-or-wikilink>");
    return 1;
  }
  return withIndex(ctx, (db, workspace) => {
    const page = getPage(db, target, workspace.config);
    if (!page) {
      ctx.err(`No page matches "${target}".`);
      return 1;
    }
    ctx.out(`# ${page.title}`);
    ctx.out(`path: ${page.path}`);
    ctx.out(`type: ${page.type}`);
    if (page.canonicalSource) ctx.out(`canonical_source: ${page.canonicalSource}`);
    if (page.lastVerifiedRevision) ctx.out(`verified at: ${page.lastVerifiedRevision}`);
    ctx.out("");
    ctx.out(page.body.trim());
    return 0;
  });
}

export function consumers(
  ctx: CommandContext,
  target: string,
  options: { includeInline?: boolean } = {},
): number {
  if (!target) {
    ctx.err("Usage: accreta consumers <path-or-wikilink> [--inline]");
    return 1;
  }
  return withIndex(ctx, (db, workspace) => {
    const result = findRelated(db, target, workspace.config, {
      includeInline: options.includeInline,
    });
    if (!result.targetExists) ctx.out(`(no page at ${result.target})`);
    if (result.relations.length === 0) {
      ctx.out(
        options.includeInline
          ? "No relations."
          : "No declared relations. Pass --inline to include inline [[mentions]].",
      );
      return 0;
    }
    for (const relation of result.relations) {
      const arrow = relation.direction === "inbound" ? "←" : "→";
      ctx.out(`${arrow} ${relation.path}  [${relation.kind}]  ${relation.title ?? ""}`);
    }
    ctx.out(`\n${result.relations.length} relation(s).`);
    return 0;
  });
}

export function canonical(ctx: CommandContext, term: string): number {
  if (!term) {
    ctx.err("Usage: accreta canonical <term>");
    return 1;
  }
  return withIndex(ctx, (db, workspace) => {
    const matches = findCanonical(db, term, workspace.config);
    if (matches.length === 0) {
      ctx.out(`Nothing is canonical for "${term}".`);
      return 0;
    }
    for (const match of matches) {
      ctx.out(`${match.path}  [${match.type}]  (matched on ${match.matchedOn})`);
      if (match.canonicalSource) ctx.out(`  source: ${match.canonicalSource}`);
    }
    return 0;
  });
}

export async function drift(
  ctx: CommandContext,
  options: { strict?: boolean } = {},
): Promise<number> {
  const workspace = findWorkspace(ctx.cwd);
  if (!existsSync(workspace.indexPath)) {
    throw new Error(`No index at ${workspace.indexPath}. Run \`accreta reindex\` first.`);
  }

  const sources = loadSources(workspace);
  if (sources.length === 0) {
    ctx.out("No sources declared in sources/. Nothing to check.");
    return 0;
  }

  const db = openIndex(workspace.indexPath, { readonly: true });
  let exitCode = 0;
  try {
    for (const adapter of sources) {
      const report = await detectDrift(db, adapter);

      // A source only the agent can reach produces a work order rather than a
      // verdict, so it is printed on its own terms and skips the outcomes below
      // — every one of which would imply somebody had looked.
      if (report.delegated) {
        const work = report.delegated;
        const pageCount = work.pending.reduce((total, entry) => total + entry.pages.length, 0);
        ctx.out(`${adapter.id} — read through ${work.via} by the agent, not by accreta`);

        if (pageCount > 0) {
          ctx.out(`  ${pageCount} page(s) for the agent to re-verify there:`);
          for (const entry of work.pending) {
            for (const path of entry.pages) {
              ctx.out(`    ${path} (verified at ${entry.revision})`);
            }
          }
        } else {
          ctx.out("  no pages cite it yet");
        }
        if (report.unverifiable.length > 0) {
          ctx.out(`  ${report.unverifiable.length} page(s) record no revision at all`);
        }
        ctx.out("  in scope:");
        for (const line of work.guidance.trim().split("\n")) ctx.out(`    ${line}`);

        if (options.strict && (pageCount > 0 || report.unverifiable.length > 0)) exitCode = 1;
        continue;
      }

      ctx.out(`${adapter.id} @ ${report.currentRevision}`);

      if (report.stale.length > 0) {
        // Summed over the groups rather than taken from `report.stale.length`,
        // which counts revisions now that the report is grouped. The reader is
        // being told how many pages are in doubt.
        const pageCount = report.stale.reduce((total, entry) => total + entry.pages.length, 0);
        ctx.out(`  ${pageCount} page(s) may have drifted:`);
        for (const entry of report.stale) {
          for (const path of entry.pages) {
            ctx.out(`    ${path} (verified at ${entry.revision})`);
          }
        }
        exitCode = 1;
      }
      // Reported separately because "I cannot tell" is not "out of date", and
      // collapsing them would misrepresent what the system actually knows.
      if (report.unresolvable.length > 0) {
        ctx.out(`  ${report.unresolvable.length} revision(s) this source cannot place:`);
        for (const entry of report.unresolvable) {
          ctx.out(`    ${entry.revision} — ${entry.pages.length} page(s)`);
        }
        exitCode = 1;
      }
      if (report.unverifiable.length > 0) {
        ctx.out(`  ${report.unverifiable.length} page(s) record no revision at all`);
        if (options.strict) exitCode = 1;
      }
      if (report.stale.length === 0 && report.unresolvable.length === 0) {
        ctx.out("  up to date");
      }
    }
  } finally {
    db.close();
  }
  return exitCode;
}

/**
 * Write a source declaration, then say whether anything can reach it.
 *
 * The `--set` pairs go into the declaration untouched, because the CLI knows no
 * more about a source's options than the core does — the same rule the registry
 * already follows for everything besides `id` and `type`.
 */
export async function sourceAdd(
  ctx: CommandContext,
  type: string,
  id: string,
  overrides: Record<string, string>,
): Promise<number> {
  if (!type || !id) {
    ctx.err("Usage: accreta source add <type> <id> [--set key=value]");
    ctx.err(`Types: ${KNOWN_TYPES.join(", ")}`);
    return 1;
  }

  const kind = kindFor(type);
  if (!kind) {
    ctx.err(`Unknown source type "${type}". Known: ${KNOWN_TYPES.join(", ")}.`);
    return 1;
  }

  const workspace = findWorkspace(ctx.cwd);
  const dir = join(workspace.root, "sources");
  mkdirSync(dir, { recursive: true });

  const path = join(dir, `${id}.yaml`);
  if (existsSync(path)) {
    ctx.err(`sources/${id}.yaml already exists. Leaving it alone.`);
    return 1;
  }

  writeFileSync(path, applyOverrides(kind.template(id), overrides), "utf-8");
  ctx.out(`Wrote sources/${id}.yaml`);

  const preflight = await kind.preflight(
    { id, type, options: parseSourceDeclaration(readFileSync(path, "utf-8")).options },
    { root: workspace.root, citationFormat: workspace.config.provenanceFormat },
  );
  reportPreflight(ctx, preflight, "  ");
  return 0;
}

/** Replace `key: …` lines the user overrode, leaving the template's comments in place. */
function applyOverrides(template: string, overrides: Record<string, string>): string {
  let out = template;
  for (const [key, value] of Object.entries(overrides)) {
    const line = new RegExp(`^${key}:.*$`, "m");
    out = line.test(out) ? out.replace(line, `${key}: ${value}`) : `${out}${key}: ${value}\n`;
  }
  return out;
}

function reportPreflight(ctx: CommandContext, preflight: Preflight, indent: string): void {
  const label = preflight.reachable === "yes" ? "ok" : preflight.reachable;
  ctx.out(`${indent}${label}: ${preflight.detail}`);
  if (preflight.remedy) ctx.out(`${indent}  → ${preflight.remedy}`);
  if (preflight.agentAccess) {
    ctx.out(`${indent}your agent needs: ${preflight.agentAccess.connector} — unverified`);
    ctx.out(`${indent}  → ${preflight.agentAccess.hint}`);
  }
}

/**
 * Say what is wired up and what is not, and never guess at the difference.
 *
 * Everything here is read-only on purpose. The one thing a user most wants
 * checked — whether their agent can actually reach a delegated source — is the
 * one thing no file on this machine records, so it is reported as unverified
 * rather than inferred from the absence of evidence.
 */
export async function doctor(ctx: CommandContext): Promise<number> {
  const workspace = findWorkspace(ctx.cwd);
  let exitCode = 0;
  ctx.out(`accreta doctor — ${workspace.root}`);

  ctx.out("\nconfig");
  const check = checkConfig(readFileSync(join(workspace.root, CONFIG_FILENAME), "utf-8"));
  if (check.error) {
    // Everything else reads this file through `parseConfig`, which degrades to
    // the defaults rather than throwing. That is the right trade there and it
    // means a knowledge base can lint against page types nobody chose.
    ctx.out(`  broken: ${CONFIG_FILENAME} did not parse — ${check.error}`);
    ctx.out("    → every command is running on the default vocabulary, silently");
    exitCode = 1;
  } else {
    ctx.out(`  ok: ${CONFIG_FILENAME} parses`);
  }
  if (/\{start\}|\{end\}/.test(workspace.config.provenanceFormat)) {
    ctx.out("  stale: provenance.format still uses {start} and {end}");
    ctx.out(`    → replace them with {locator}: "${DEFAULT_CONFIG.provenanceFormat}"`);
  }

  ctx.out("\nindex");
  ctx.out(
    existsSync(workspace.indexPath)
      ? `  ok: ${workspace.indexPath}`
      : "  missing: run `accreta reindex`",
  );

  const declarations = readDeclarations(workspace.root);
  ctx.out(`\nsources (${declarations.length})`);
  if (declarations.length === 0) ctx.out("  none declared in sources/");

  for (const declaration of declarations) {
    ctx.out(`  ${declaration.id} — ${declaration.type}`);
    const kind = kindFor(declaration.type);
    if (!kind) {
      ctx.out(`    no: unknown source type. Known: ${KNOWN_TYPES.join(", ")}.`);
      exitCode = 1;
      continue;
    }
    // Preflight never constructs the adapter, so a half-written declaration is
    // reported here rather than thrown from a diagnostic command.
    const preflight = await kind.preflight(declaration, {
      root: workspace.root,
      citationFormat: workspace.config.provenanceFormat,
    });
    reportPreflight(ctx, preflight, "    ");
    if (preflight.reachable === "no") exitCode = 1;
  }

  ctx.out("\nmcp");
  ctx.out(
    mentionsAccretaServer(workspace.root)
      ? "  ok: .mcp.json in this workspace names accreta's server"
      : "  unknown: no .mcp.json here names accreta's server — the agent may be configured elsewhere",
  );

  return exitCode;
}

/** Only this workspace's file. An agent configured elsewhere is invisible, and saying so is the point. */
function mentionsAccretaServer(root: string): boolean {
  const path = join(root, ".mcp.json");
  if (!existsSync(path)) return false;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as {
      mcpServers?: Record<string, unknown>;
    };
    return Object.keys(parsed.mcpServers ?? {}).some((name) => name.includes("accreta"));
  } catch {
    return false;
  }
}

export { indexPathFor };
