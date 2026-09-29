import { existsSync, realpathSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import type { SourceAdapter, SourceDeclaration } from "@accreta/core";
import { FsSource, SNAPSHOT_BUDGET_BYTES, snapshotHealth } from "@accreta/adapter-fs";
import { GitSource, isWorkingTree } from "@accreta/adapter-git";
import { DelegatedSource } from "@accreta/adapter-delegated";

export interface SourceContext {
  /** Workspace root. A declaration's own `root` is resolved against it. */
  root: string;
  /** `provenance.format`, handed to every adapter as its citation template. */
  citationFormat: string;
  /** Where adapters keep local state: the index's directory, from `stateDirFor`. */
  stateDir: string;
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

/**
 * The index's directory. The default is kept as written so a committed `.accreta` symlink is
 * caught; one the operator chose through ACCRETA_INDEX_PATH is resolved, symlinks and all.
 */
export function stateDirFor(root: string, indexPath: string): string {
  const dir = dirname(indexPath);
  if (dir === join(root, ".accreta")) return dir;
  try {
    return realpathSync(dir);
  } catch {
    return dir;
  }
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
# is invisible to this source. The listing behind each revision is kept in
# fs-snapshots/ beside the index. Every revision a page cites is kept, and older
# ones are pruned past ${SNAPSHOT_BUDGET_BYTES / 1024 / 1024} MiB. A revision whose
# listing is gone is reported as "cannot place" rather than guessed at.
# \`accreta doctor\` says when snapshots cannot be kept, and why.
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
      stateDir: ctx.stateDir,
    }),
  preflight: async (d, ctx) => {
    const root = rootOf(d, ctx);
    const bad = checkDirectory(root);
    if (bad) return bad;
    const health = snapshotHealth({
      id: d.id,
      root,
      citationFormat: ctx.citationFormat,
      extensions: stringsOr(d.options.extensions),
      stateDir: ctx.stateDir,
    });
    if (!health.persists) {
      return {
        reachable: "yes",
        detail: `${root} is readable, but snapshots cannot persist: ${health.detail}`,
        remedy:
          "Until this is fixed, drift from a new process reports this source as cannot place.",
      };
    }
    const note = health.detail ? `; snapshots: ${health.detail}` : "";
    return { reachable: "yes", detail: `${root} is readable${note}` };
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
