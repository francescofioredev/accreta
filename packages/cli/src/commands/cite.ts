import {
  cite as citeAt,
  parseCitation,
  type Citation,
  type ParsedCitation,
  type SourceAdapter,
} from "@accreta/core";
import { notLoadedError, withRevisionRefusal } from "@accreta/adapters";
import { findWorkspace } from "../workspace.ts";
import {
  loadSources,
  printable,
  printableBlock,
  printableLines,
  printJson,
  provenance,
  SOURCE_NOTICE,
  type CommandContext,
} from "./shared.ts";

const CITE_FIELDS = ["location.detail", "delegated.via", "delegated.scope"] as const;

const USAGE =
  "Usage: accreta cite <source>:<path>[#locator]... [--expect-revision <rev>] [--json | --format text|footnote|json]";

export type CiteFormat = "text" | "footnote" | "json";

/**
 * `--format`'s value in the raw arguments, and the positionals left once it is taken out.
 * `COMMAND_ARGS` has already refused any flag cite does not take. A string is a refusal.
 */
export function citeArguments(
  args: readonly string[],
  positional: readonly string[],
  json: boolean,
): { format: CiteFormat; targets: string[] } | string {
  let given: string | undefined;
  let separate = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--") break;
    if (arg !== "--format" && !arg.startsWith("--format=")) continue;
    // A second value would be left behind as a target.
    if (given !== undefined) return "--format is given more than once.";
    separate = arg === "--format";
    given = separate ? (args[++i] ?? "") : arg.slice("--format=".length);
  }
  if (given === undefined) return { format: json ? "json" : "text", targets: [...positional] };
  if (given !== "text" && given !== "footnote" && given !== "json") {
    return `--format takes text, footnote or json, not "${printable(given)}".`;
  }
  if (json && given !== "json") return `--json and --format ${given} ask for different output.`;
  const targets = [...positional];
  // No target can be named text, footnote or json: each lacks the "source:" part.
  if (separate) targets.splice(targets.indexOf(given), 1);
  return { format: given, targets };
}

export async function cite(
  ctx: CommandContext,
  args: readonly string[],
  positional: readonly string[],
  options: { json?: boolean; expectRevision?: string } = {},
): Promise<number> {
  const parsed = citeArguments(args, positional, options.json ?? false);
  if (typeof parsed === "string") {
    ctx.err(parsed);
    return 2;
  }
  const { format } = parsed;
  if (parsed.targets.length === 0) {
    ctx.err(USAGE);
    return 2;
  }
  const targets: ParsedCitation[] = [];
  for (const raw of parsed.targets) {
    const target = parseCitation(raw);
    if (!target) {
      ctx.err(
        `"${printable(raw)}" is not source:path[#locator]; a path with "#" or whitespace in it cannot be cited.`,
      );
      return 2;
    }
    targets.push(target);
  }
  const named = [...new Set(targets.map((t) => t.sourceId))];
  // One revision cannot vouch for two sources; the check would fail as a misleading "moved".
  if (options.expectRevision !== undefined && named.length > 1) {
    ctx.err(
      `--expect-revision is one source's revision, but the targets name ${named.map(printable).join(", ")}. Cite each source in its own call.`,
    );
    return 2;
  }

  // No index: a citation asks the source, never the pages.
  const workspace = findWorkspace(ctx.cwd);
  const loaded = loadSources(workspace);
  const sources = new Map(
    loaded.sources.map((adapter) => [adapter.id, revisionOnce(withRevisionRefusal(adapter))]),
  );
  // Every target is checked before any is cited, so bad input prints no partial answer.
  for (const target of targets) {
    if (loaded.unloaded.some((u) => u.id === target.sourceId)) {
      // Escaped once, where main prints it.
      throw new Error(notLoadedError(target.sourceId));
    }
    // Input errors exit 2, not 1 like a refusal; the sentences are core's, which MCP returns.
    if (!sources.has(target.sourceId)) {
      const known = [...sources.keys()].toSorted().map(printable).join(", ") || "none";
      ctx.err(`Unknown source "${printable(target.sourceId)}". Configured sources: ${known}.`);
      return 2;
    }
    if (target.path.split("/").some((part) => part === "" || part === "." || part === "..")) {
      ctx.err(
        `Path "${printable(target.path)}" is not canonical: it has an empty, "." or ".." segment`,
      );
      return 2;
    }
  }

  // One target off the expected revision refuses them all, before anything is printed.
  const citations: Citation[] = [];
  for (const target of targets) {
    citations.push(
      await citeAt(sources, workspace.config.provenanceFormat, target, {
        expectRevision: options.expectRevision,
      }),
    );
  }
  // On stderr, so stdout stays the footnotes or the labelled lines; one source, so one note.
  const prefixed = citations.find((c) => c.matchedPrefix !== undefined);
  if (prefixed?.matchedPrefix !== undefined && prefixed.revision !== null && format !== "json") {
    ctx.err(
      `--expect-revision ${printable(prefixed.matchedPrefix)} matched ${printable(prefixed.revision)} as a prefix; the footnote names it in full.`,
    );
  }
  // A place that is not there must not look like a citation to paste.
  const code = citations.some((c) => c.location.verdict === "missing") ? 1 : 0;

  if (format === "json") {
    const shaped = citations.map(toJson);
    // One target stays an object, field for field the MCP tool's.
    printJson(ctx, shaped.length === 1 ? shaped[0] : shaped);
    return code;
  }
  if (format === "footnote") {
    // All or nothing: line N is always target N, and a missing place leaves stdout empty.
    for (const { canonicalSource, location } of citations) {
      if (location.verdict === "missing") {
        ctx.err(
          `${printable(canonicalSource)}: missing ${location.part}: ${printable(location.detail)}`,
        );
      }
    }
    if (code === 0) for (const citation of citations) ctx.out(citation.footnote);
    return code;
  }

  for (const [i, citation] of citations.entries()) {
    if (i > 0) ctx.out("");
    printBlock(ctx, citation);
  }
  return code;
}

function toJson(citation: Citation) {
  return {
    canonical_source: citation.canonicalSource,
    footnote: citation.footnote,
    revision: citation.revision,
    location: citation.location,
    ...(citation.delegated
      ? { delegated: { via: citation.delegated.via, scope: citation.delegated.guidance } }
      : {}),
    ...(citation.matchedPrefix !== undefined ? { matched_prefix: citation.matchedPrefix } : {}),
    _provenance: provenance(CITE_FIELDS, SOURCE_NOTICE),
  };
}

/** The same keys in the same order whatever the verdict, so a script reads them by label. */
function printBlock(ctx: CommandContext, citation: Citation): void {
  const missing = citation.location.verdict === "missing";
  ctx.out(`footnote: ${missing ? "none: location missing" : printable(citation.footnote)}`);
  ctx.out(`canonical_source: ${printable(citation.canonicalSource)}`);
  ctx.out(
    `revision: ${citation.revision === null ? "none, so the footnote is unpinned" : printable(citation.revision)}`,
  );
  ctx.out(continued(locationLine(citation)));
  if (citation.delegated) {
    const { via, guidance } = citation.delegated;
    const scope = printableBlock(guidance.trimEnd());
    ctx.out(continued(`delegated: read through ${printable(via)}; scope:\n${scope}`));
  }
}

function locationLine({ location }: Citation): string {
  if (location.verdict === "found") return "location: found";
  if (location.verdict === "unknown")
    return `location: unknown: ${printableLines(location.detail)}`;
  return `location: missing ${location.part}: ${printableLines(location.detail)}`;
}

/** Indents every line after the first, a blank one as two spaces, so none can pose as a label. */
function continued(text: string): string {
  return text.split(/\r?\n/).join("\n  ");
}

/** One revision per source per call, so a batch never reports two for the same source. */
export function revisionOnce(adapter: SourceAdapter): SourceAdapter {
  let revision: Promise<string> | undefined;
  return new Proxy(adapter, {
    get(target, prop) {
      if (prop === "revision") return () => (revision ??= target.revision());
      const value: unknown = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
