import { cite as citeAt, parseCitation, type Citation } from "@accreta/core";
import { findWorkspace } from "../workspace.ts";
import {
  loadSources,
  printJson,
  provenance,
  SOURCE_NOTICE,
  type CommandContext,
} from "./shared.ts";

const CITE_FIELDS = ["location.detail"] as const;

const USAGE =
  "Usage: accreta cite <source>:<path>[#locator] [--expect-revision <rev>] [--json | --format footnote]";

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
    if (arg === "--format") {
      given = args[++i] ?? "";
      separate = true;
    } else if (arg.startsWith("--format=")) {
      given = arg.slice("--format=".length);
      separate = false;
    }
  }
  if (given === undefined) return { format: json ? "json" : "text", targets: [...positional] };
  if (given !== "text" && given !== "footnote" && given !== "json") {
    return `--format takes text, footnote or json, not "${given}".`;
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
  const { format, targets } = parsed;
  if (targets.length > 1) {
    ctx.err(`cite does not take "${targets.slice(1).join(" ")}".`);
    return 2;
  }
  const raw = targets[0] ?? "";
  const target = parseCitation(raw);
  if (!target) {
    ctx.err(
      raw
        ? `"${raw}" is not source:path[#locator]; a path with "#" or whitespace in it cannot be cited.`
        : USAGE,
    );
    return 2;
  }

  // No index: a citation asks the source, never the pages.
  const workspace = findWorkspace(ctx.cwd);
  const loaded = loadSources(workspace);
  const broken = loaded.unloaded.find((u) => u.id === target.sourceId);
  if (broken) {
    throw new Error(
      `Source "${target.sourceId}" is declared in ${broken.file} but did not load: ${broken.reason}`,
    );
  }
  const sources = new Map(loaded.sources.map((adapter) => [adapter.id, adapter]));
  // Input errors exit 2, not 1 like a refusal; the sentences are core's, which MCP returns.
  if (!sources.has(target.sourceId)) {
    const known = [...sources.keys()].toSorted().join(", ") || "none";
    ctx.err(`Unknown source "${target.sourceId}". Configured sources: ${known}.`);
    return 2;
  }
  if (target.path.split("/").some((part) => part === "" || part === "." || part === "..")) {
    ctx.err(`Path "${target.path}" is not canonical: it has an empty, "." or ".." segment`);
    return 2;
  }

  const citation = await citeAt(sources, workspace.config.provenanceFormat, target);
  const expected = options.expectRevision;
  if (expected !== undefined && citation.revision !== expected) {
    throw new Error(
      citation.revision !== null
        ? `Source "${target.sourceId}" is at ${citation.revision}, not ${expected}: it moved since you read it, or ${expected} did not come from cite. Re-read ${citation.canonicalSource}, then cite again.`
        : citation.delegated
          ? `Cannot confirm source "${target.sourceId}" is still at ${expected}: it is read through ${citation.delegated.via}, and accreta cannot tell its revision.`
          : `Cannot confirm source "${target.sourceId}" is still at ${expected}: accreta could not check this place. Cite it without an expected revision to see why.`,
    );
  }
  // A place that is not there must not look like a citation to paste.
  const missing = citation.location.verdict === "missing";
  const code = missing ? 1 : 0;

  if (format === "json") {
    printJson(ctx, {
      canonical_source: citation.canonicalSource,
      footnote: citation.footnote,
      revision: citation.revision,
      location: citation.location,
      ...(citation.delegated
        ? { delegated: { via: citation.delegated.via, scope: citation.delegated.guidance } }
        : {}),
      _provenance: provenance(CITE_FIELDS, SOURCE_NOTICE),
    });
    return code;
  }
  if (format === "footnote") {
    // Empty stdout when missing, so `$(accreta cite --format footnote …)` never captures an error.
    const { location } = citation;
    // Names the target: stderr has no canonical_source line beside it.
    if (location.verdict === "missing") {
      ctx.err(`${citation.canonicalSource}: missing ${location.part}: ${location.detail}`);
    } else {
      ctx.out(citation.footnote);
    }
    return code;
  }

  // The same keys in the same order whatever the verdict, so a script reads them by label.
  ctx.out(`footnote: ${missing ? "none: location missing" : citation.footnote}`);
  ctx.out(`canonical_source: ${citation.canonicalSource}`);
  ctx.out(`revision: ${citation.revision ?? "none, so the footnote is unpinned"}`);
  ctx.out(locationLine(citation));
  if (citation.delegated) {
    ctx.out(`delegated: read through ${citation.delegated.via}; scope:`);
    ctx.out(citation.delegated.guidance.trimEnd());
  }
  return code;
}

function locationLine({ location }: Citation): string {
  if (location.verdict === "found") return "location: found";
  if (location.verdict === "unknown") return `location: unknown: ${location.detail}`;
  return `location: missing ${location.part}: ${location.detail}`;
}
