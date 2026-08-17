import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import {
  detectDrift,
  findCanonical,
  findRelated,
  getPage,
  lint,
  lintCitations,
  searchPages,
  type AccretaConfig,
  type CanonicalMatch,
  type Database,
  type PageRecord,
  type Relation,
  type SearchHit,
  type SourceAdapter,
} from "@accreta/core";

export interface ToolContext {
  db: Database;
  config: AccretaConfig;
  root: string;
  sources: Map<string, SourceAdapter>;
  /** Whether write tools are permitted. Off unless ACCRETA_ALLOW_WRITES is set. */
  writesEnabled: boolean;
}

/**
 * Shape a core record for the MCP boundary.
 *
 * The renames live here rather than in the core types because the CLI reads
 * those directly — same constraint that kept `check_drift`'s rename at the
 * boundary. What is new is that these are *records*, returned by three tools at
 * once, so the mapping is shared rather than written at each return site.
 */
function pageOut(page: PageRecord) {
  return {
    path: page.path,
    type: page.type,
    title: page.title,
    source: page.source,
    canonical_source: page.canonicalSource,
    last_verified_revision: page.lastVerifiedRevision,
    frontmatter: page.frontmatter,
    body: page.body,
  };
}

function hitOut(hit: SearchHit) {
  return {
    path: hit.path,
    type: hit.type,
    title: hit.title,
    source: hit.source,
    snippet: hit.snippet,
    last_verified_revision: hit.lastVerifiedRevision,
  };
}

function matchOut(match: CanonicalMatch) {
  return {
    path: match.path,
    title: match.title,
    type: match.type,
    canonical_source: match.canonicalSource,
    matched_on: match.matchedOn,
  };
}

function relationOut(relation: Relation) {
  return {
    path: relation.path,
    kind: relation.kind,
    direction: relation.direction,
    type: relation.type,
    title: relation.title,
  };
}

export function searchPagesTool(
  ctx: ToolContext,
  input: { query: string; types?: string[]; source?: string; limit?: number },
) {
  const hits = searchPages(ctx.db, input);
  return { count: hits.length, results: hits.map(hitOut) };
}

export function getPageTool(ctx: ToolContext, input: { path: string }) {
  const page = getPage(ctx.db, input.path, ctx.config);
  if (!page) {
    return { found: false as const, message: `No page matches "${input.path}".` };
  }
  return { found: true as const, page: pageOut(page) };
}

export function findConsumersTool(
  ctx: ToolContext,
  input: { target: string; kinds?: string[]; include_inline?: boolean },
) {
  const result = findRelated(ctx.db, input.target, ctx.config, {
    kinds: input.kinds,
    includeInline: input.include_inline,
  });
  return {
    target: result.target,
    target_exists: result.targetExists,
    count: result.relations.length,
    results: result.relations.map(relationOut),
  };
}

export function findCanonicalTool(ctx: ToolContext, input: { term: string }) {
  const matches = findCanonical(ctx.db, input.term, ctx.config);
  return { count: matches.length, results: matches.map(matchOut) };
}

export async function checkDriftTool(ctx: ToolContext, input: { source?: string }) {
  const adapters = input.source
    ? [ctx.sources.get(input.source)].filter((a): a is SourceAdapter => Boolean(a))
    : [...ctx.sources.values()];

  if (adapters.length === 0) {
    return {
      message: input.source
        ? `No source named "${input.source}". Known: ${[...ctx.sources.keys()].join(", ") || "none"}.`
        : "No sources are declared.",
      reports: [],
    };
  }

  // Pinned once: the context reopens the index when a rebuild swaps it, and
  // this loop spans awaits. Re-reading it per adapter could draw one report
  // from two different indexes.
  const db = ctx.db;
  const reports = [];
  for (const adapter of adapters) {
    reports.push(await detectDrift(db, adapter));
  }

  // Renamed here rather than in `DriftReport` itself: the CLI reads the core
  // shape directly, so moving the names would break it to tidy this surface.
  return {
    reports: reports.map((report) => ({
      source_id: report.sourceId,
      current_revision: report.currentRevision,
      stale: report.stale.map((entry) => ({
        revision: entry.revision,
        changed_paths: entry.changedPaths,
        pages: entry.pages,
      })),
      unverifiable: report.unverifiable,
      unresolvable: report.unresolvable,
    })),
  };
}

export async function listRecentChangesTool(
  ctx: ToolContext,
  input: { source: string; since: string },
) {
  const adapter = ctx.sources.get(input.source);
  if (!adapter) {
    return { message: `No source named "${input.source}".`, changed: [] };
  }
  try {
    return { source: adapter.id, changed: await adapter.changedSince(input.since) };
  } catch (error) {
    // "I cannot tell" reaches the agent as itself. Returning an empty list here
    // would read as "nothing changed", which is a different claim.
    return {
      source: adapter.id,
      unresolvable: true as const,
      message: error instanceof Error ? error.message : String(error),
      changed: [],
    };
  }
}

export async function lintTool(ctx: ToolContext) {
  const db = ctx.db;
  const report = lint(db, ctx.config);
  const citations = await lintCitations(db, ctx.sources);
  const findings = [...report.findings, ...citations.findings];
  return {
    pages_checked: report.pagesChecked,
    count: findings.length,
    findings,
  };
}

/**
 * A token derived from exactly what the write would do.
 *
 * The point is that a token cannot be produced without having run the dry run,
 * and cannot be reused for a different edit: change the page, the revision or
 * the current value, and the token no longer matches. A plain "confirm: true"
 * flag would let a model skip straight to writing.
 */
function confirmToken(path: string, revision: string, currentValue: string): string {
  return createHash("sha256")
    .update(`${path}\0${revision}\0${currentValue}`)
    .digest("hex")
    .slice(0, 16);
}

export interface UpdateVerifiedInput {
  path: string;
  revision: string;
  confirm_token?: string;
}

/**
 * Record the revision a page has been verified against.
 *
 * The only write tool. Gated twice: `ACCRETA_ALLOW_WRITES` must be set for it to
 * exist at all, and every call must be preceded by a dry run whose token is
 * echoed back. Provenance is the project's substance — a tool that can rewrite
 * it silently, on a model's initiative, is the one tool most worth making
 * difficult.
 */
export function updateVerifiedRevisionTool(ctx: ToolContext, input: UpdateVerifiedInput) {
  if (!ctx.writesEnabled) {
    return {
      ok: false as const,
      message:
        "Writes are disabled. Set ACCRETA_ALLOW_WRITES=1 in the server environment to enable this tool.",
    };
  }

  const page = getPage(ctx.db, input.path, ctx.config);
  if (!page) {
    return { ok: false as const, message: `No page matches "${input.path}".` };
  }

  const current = page.lastVerifiedRevision ?? "";
  const token = confirmToken(page.path, input.revision, current);

  if (input.confirm_token !== token) {
    return {
      ok: false as const,
      dry_run: true as const,
      path: page.path,
      current_revision: page.lastVerifiedRevision,
      new_revision: input.revision,
      confirm_token: token,
      message:
        input.confirm_token === undefined
          ? "Dry run. Call again with this confirm_token to apply."
          : "confirm_token does not match this edit. Re-run the dry run and use the token it returns.",
    };
  }

  const absolute = join(ctx.root, page.path);
  const raw = readFileSync(absolute, "utf-8");
  const updated = setFrontmatterField(raw, "last_verified_revision", input.revision);
  writeFileSync(absolute, updated, "utf-8");

  return {
    ok: true as const,
    path: page.path,
    previous_revision: page.lastVerifiedRevision,
    new_revision: input.revision,
    message: "Written. Run `accreta reindex` for the index to reflect this.",
  };
}

/**
 * Set one frontmatter field, leaving the rest of the file byte-identical.
 *
 * A parse-and-reserialize would reformat the whole block — reordering keys,
 * normalizing quotes, and destroying the wikilink syntax the preprocessing pass
 * exists to accommodate. This edits the one line, or inserts it.
 */
export function setFrontmatterField(raw: string, field: string, value: string): string {
  const match = raw.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*(\r?\n|$)/);
  if (!match) {
    return `---\n${field}: ${value}\n---\n\n${raw}`;
  }

  const block = match[1] ?? "";
  const lineRe = new RegExp(`^(\\s*)${field}\\s*:.*$`, "m");
  const newBlock = lineRe.test(block)
    ? block.replace(lineRe, `$1${field}: ${value}`)
    : `${block}\n${field}: ${value}`;

  return (
    raw.slice(0, match.index ?? 0) +
    `---\n${newBlock}\n---\n` +
    raw.slice((match.index ?? 0) + match[0].length)
  );
}
