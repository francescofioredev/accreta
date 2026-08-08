import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildIndex,
  detectDrift,
  findCanonical,
  findRelated,
  getPage,
  lint,
  openIndex,
  parseSourceDeclaration,
  searchPages,
  SourceRegistry,
  type SourceAdapter,
} from "@accreta/core";
import { FsSource } from "@accreta/adapter-fs";
import { GitSource } from "@accreta/adapter-git";
import { CONFIG_FILENAME, findWorkspace, indexPathFor, type Workspace } from "./workspace.ts";
import { composeConstitution, isPreset, PRESETS, type Preset } from "./constitution.ts";

export interface CommandContext {
  cwd: string;
  out: (line: string) => void;
  err: (line: string) => void;
}

/**
 * The adapters this build knows how to construct.
 *
 * Registration lives here, in the surface, rather than in the core: the core's
 * whole purpose is not to know which adapters exist.
 */
function buildRegistry(workspace: Workspace): SourceRegistry {
  const format = workspace.config.provenanceFormat;
  return new SourceRegistry()
    .register(
      "fs",
      (d) =>
        new FsSource({
          id: d.id,
          root: join(workspace.root, String(d.options.root ?? ".")),
          citationFormat: format,
          extensions: Array.isArray(d.options.extensions)
            ? (d.options.extensions as string[])
            : undefined,
        }),
    )
    .register(
      "git",
      (d) =>
        new GitSource({
          id: d.id,
          root: join(workspace.root, String(d.options.root ?? ".")),
          citationFormat: format,
        }),
    );
}

/** Load every `sources/*.yaml` declaration in the workspace. */
function loadSources(workspace: Workspace): SourceAdapter[] {
  const dir = join(workspace.root, "sources");
  if (!existsSync(dir)) return [];

  const registry = buildRegistry(workspace);
  const out: SourceAdapter[] = [];
  for (const name of readdirSync(dir).toSorted()) {
    if (!name.endsWith(".yaml") && !name.endsWith(".yml")) continue;
    const declaration = parseSourceDeclaration(readFileSync(join(dir, name), "utf-8"));
    out.push(registry.create(declaration));
  }
  return out;
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
  format: "{source} @ {rev} · {path}#L{start}-L{end}"
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
  format: "{source} @ {rev} · {path}#L{start}-L{end}"
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
  format: "{source} @ {rev} · {path}#L{start}-L{end}"
`;

const SOURCE_TEMPLATE = `# A source is anything with a revision and a way to report what changed.
#
#   type: fs   — a directory of documents; revision is a hash of modification times
#   type: git  — a repository; revision is a commit SHA
#
# Every key besides id and type is passed to the adapter untouched.

id: example
type: fs
root: sources/example
extensions: [".md"]
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
  if (!existsSync(examplePath)) writeFileSync(examplePath, SOURCE_TEMPLATE, "utf-8");

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

export function runLint(ctx: CommandContext): number {
  return withIndex(ctx, (db, workspace) => {
    const report = lint(db, workspace.config);
    if (report.findings.length === 0) {
      ctx.out(`${report.pagesChecked} page(s) checked, nothing to report.`);
      return 0;
    }

    const byKind = new Map<string, typeof report.findings>();
    for (const finding of report.findings) {
      const list = byKind.get(finding.kind);
      if (list) list.push(finding);
      else byKind.set(finding.kind, [finding]);
    }

    for (const [kind, findings] of byKind) {
      ctx.out(`\n${kind} (${findings.length})`);
      for (const finding of findings) ctx.out(`  ${finding.path}: ${finding.detail}`);
    }
    ctx.out(`\n${report.findings.length} finding(s) across ${report.pagesChecked} page(s).`);

    // A non-zero exit so CI can fail on an unresolvable link.
    return 1;
  });
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

export async function drift(ctx: CommandContext): Promise<number> {
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
      ctx.out(`${adapter.id} @ ${report.currentRevision}`);

      if (report.stale.length > 0) {
        ctx.out(`  ${report.stale.length} page(s) may have drifted:`);
        for (const page of report.stale) {
          ctx.out(`    ${page.path} (verified at ${page.verifiedAt})`);
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

export { indexPathFor };
