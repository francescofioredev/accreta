import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import type { SourceAdapter, SourceDeclaration } from "@accreta/core";
import { FsSource } from "@accreta/adapter-fs";
import { GitSource, isWorkingTree } from "@accreta/adapter-git";
import { DelegatedSource } from "@accreta/adapter-delegated";

export interface SourceContext {
  /** Workspace root. A declaration's own `root` is resolved against it. */
  root: string;
  /** `provenance.format`, handed to every adapter as its citation template. */
  citationFormat: string;
}

/** What the agent, rather than accreta, has to be able to reach. */
export interface AgentAccess {
  /** The connector the declaration names. */
  connector: string;
  /** One line the user can act on. */
  hint: string;
}

export interface Preflight {
  /**
   * Whether accreta can reach the source.
   *
   * `unknown` is the load-bearing value, and it is ADR-0002's discipline one
   * question up. A connector authorized in somebody's agent lives in no file on
   * this machine, so reporting it absent would be exactly as wrong as reporting
   * it present.
   */
  reachable: "yes" | "no" | "unknown";
  detail: string;
  /** What to do about it, when there is something to do. */
  remedy?: string;
  agentAccess?: AgentAccess;
}

export interface SourceKind {
  readonly type: string;
  /** A commented declaration, written by `accreta source add`. */
  template(id: string): string;
  create(declaration: SourceDeclaration, ctx: SourceContext): SourceAdapter;
  /**
   * Can this source be reached, and by whom?
   *
   * Deliberately does not construct the adapter: `doctor` has to survive a
   * half-written declaration and report it, not throw on it.
   */
  preflight(declaration: SourceDeclaration, ctx: SourceContext): Promise<Preflight>;
}

const stringsOr = (value: unknown): string[] | undefined =>
  Array.isArray(value) ? (value as string[]) : undefined;

function rootOf(declaration: SourceDeclaration, ctx: SourceContext): string {
  return join(ctx.root, String(declaration.options.root ?? "."));
}

/** Both file-backed kinds want the same answer about their root. */
function checkDirectory(root: string): Preflight | null {
  if (!existsSync(root)) {
    return {
      reachable: "no",
      detail: `${root} does not exist`,
      remedy: "Create it, or point `root` at the directory that holds the documents.",
    };
  }
  if (!statSync(root).isDirectory()) {
    return { reachable: "no", detail: `${root} is not a directory` };
  }
  return null;
}

const fsKind: SourceKind = {
  type: "fs",
  template: (id) => `# A directory of documents.
#
# The revision is a hash of modification times, so a change that preserves them
# is invisible to this source. Revisions also do not survive a restart — a hash
# cannot be inverted — so \`drift\` reports "cannot place" rather than guessing.
# A corpus that needs content-level certainty wants \`type: git\`.

id: ${id}
type: fs
root: sources/${id}
extensions: [".md"]
`,
  create: (d, ctx) =>
    new FsSource({
      id: d.id,
      root: rootOf(d, ctx),
      citationFormat: ctx.citationFormat,
      extensions: stringsOr(d.options.extensions),
    }),
  preflight: async (d, ctx) => {
    const root = rootOf(d, ctx);
    return checkDirectory(root) ?? { reachable: "yes", detail: `${root} is readable` };
  },
};

const gitKind: SourceKind = {
  type: "git",
  template: (id) => `# A git repository. The revision is a commit SHA and change detection is
# \`diff --name-only\`.
#
# \`paths\` scopes the source to part of the repository. Without it, every commit
# to anything — a README, a test — reports as drift for pages whose documents
# never moved, and a report full of false positives is one people stop reading.

id: ${id}
type: git
root: .
paths: []
`,
  create: (d, ctx) =>
    new GitSource({
      id: d.id,
      root: rootOf(d, ctx),
      citationFormat: ctx.citationFormat,
      paths: stringsOr(d.options.paths),
    }),
  preflight: async (d, ctx) => {
    const root = rootOf(d, ctx);
    const bad = checkDirectory(root);
    if (bad) return bad;
    if (!(await isWorkingTree(root))) {
      return {
        reachable: "no",
        detail: `${root} is not a git repository`,
        remedy: "Point `root` at a checkout, or declare it as `type: fs` instead.",
      };
    }
    return { reachable: "yes", detail: `${root} is a git repository` };
  },
};

const delegatedKind: SourceKind = {
  type: "delegated",
  template: (id) => `# A source accreta cannot reach: your agent reads it through its own
# connector. accreta holds no credential and makes no call.
#
# \`drift\` will list the pages waiting to be re-verified and hand them to the
# agent. \`lint\` will count citations into this source as unchecked rather than
# passing them as verified — nothing here can tell an invented page id from a
# real one.

id: ${id}
type: delegated

# The connector your agent needs. A free-form name; accreta never interprets it.
via: notion

# Prose your agent reads, and the only thing that says what it may look at.
# Fill it in: an empty scope is refused rather than treated as "everything".
scope: |
`,
  create: (d, ctx) =>
    new DelegatedSource({
      id: d.id,
      via: String(d.options.via ?? ""),
      scope: String(d.options.scope ?? ""),
      citationFormat: ctx.citationFormat,
    }),
  preflight: async (d) => {
    const via = String(d.options.via ?? "").trim();
    const scope = String(d.options.scope ?? "").trim();

    if (!via) {
      return {
        reachable: "no",
        detail: "declares no `via`, so nothing says which connector reads it",
        remedy: "Add `via:` naming the connector your agent uses.",
      };
    }
    if (!scope) {
      return {
        reachable: "no",
        detail: "declares no `scope`",
        remedy:
          "Add `scope:` — prose your agent reads. Nothing else says what it may look at, " +
          "and an empty scope means either nothing or everything.",
      };
    }
    return {
      reachable: "unknown",
      // Not a failure and not a pass. accreta genuinely cannot look, and the
      // one thing that can settle it is the agent, by reading the scope once.
      detail: `accreta cannot check this source; ${via} can`,
      agentAccess: {
        connector: via,
        hint:
          `Nothing on this machine records whether your agent can reach ${via}. ` +
          `Ask it to read the declared scope once and report what came back.`,
      },
    };
  },
};

/** Every source kind this build knows. Adding one is adding an entry here. */
export const KINDS: readonly SourceKind[] = [fsKind, gitKind, delegatedKind];

export function kindFor(type: string): SourceKind | undefined {
  return KINDS.find((kind) => kind.type === type);
}

/** The types a message can offer when somebody names one that does not exist. */
export const KNOWN_TYPES = KINDS.map((kind) => kind.type);
