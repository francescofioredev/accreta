import { createHash } from "node:crypto";
import { readdirSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import {
  formatCitation,
  UNPINNED_REVISION,
  UnknownRevisionError,
  type LineRange,
  type SourceAdapter,
} from "@accreta/core";

export interface FsSourceOptions {
  id: string;
  /** Directory the source is rooted at. Paths are reported relative to it. */
  root: string;
  /** Provenance template, from `accreta.config.yaml`. */
  citationFormat: string;
  /** File extensions to consider. Empty means every file. */
  extensions?: readonly string[];
}

interface Entry {
  path: string;
  mtimeMs: number;
}

/**
 * A directory of documents as a source.
 *
 * There is no version control here, so a revision is a hash over the paths and
 * modification times of everything in the tree: it changes exactly when the
 * tree changes, which is all `revision()` promises. It is deliberately not a
 * hash of file *contents* — that would make `revision()` cost a full read of
 * the corpus on every drift check, and mtime is what a filesystem is willing to
 * answer cheaply.
 *
 * The trade-off is honest rather than hidden: a change that preserves mtime is
 * invisible to this adapter. A source that needs content-level certainty should
 * be backed by something that versions its contents, which is what the git
 * adapter is for.
 */
export class FsSource implements SourceAdapter {
  readonly id: string;
  private readonly root: string;
  private readonly citationFormat: string;
  private readonly extensions: readonly string[];

  /**
   * Snapshots taken by `revision()`, keyed by the revision they produced.
   *
   * `changedSince()` needs the *old* listing to diff against, and a hash cannot
   * be inverted. Without this the adapter could only ever answer "everything
   * changed". Entries are kept for the process lifetime; a revision from a
   * previous run is genuinely unknown, and saying so is the point of
   * UnknownRevisionError.
   */
  private readonly snapshots = new Map<string, Map<string, number>>();

  constructor(options: FsSourceOptions) {
    this.id = options.id;
    this.root = options.root;
    this.citationFormat = options.citationFormat;
    this.extensions = options.extensions ?? [];
  }

  async revision(): Promise<string> {
    const entries = this.scan();
    const hash = createHash("sha256");
    for (const entry of entries) {
      hash.update(`${entry.path}\0${entry.mtimeMs}\0`);
    }
    const revision = hash.digest("hex").slice(0, 12);
    this.snapshots.set(revision, new Map(entries.map((e) => [e.path, e.mtimeMs])));
    return revision;
  }

  async changedSince(revision: string): Promise<string[]> {
    const previous = this.snapshots.get(revision);
    if (!previous) {
      // "I cannot tell" is not "nothing changed". Conflating them would let
      // drift detection report pages as verified against a revision it has no
      // way to compare with.
      throw new UnknownRevisionError(this.id, revision);
    }

    const current = new Map(this.scan().map((e) => [e.path, e.mtimeMs]));
    const changed = new Set<string>();

    for (const [path, mtime] of current) {
      if (previous.get(path) !== mtime) changed.add(path);
    }
    for (const path of previous.keys()) {
      if (!current.has(path)) changed.add(path);
    }

    return [...changed].toSorted();
  }

  async read(path: string): Promise<string> {
    return readFile(join(this.root, path), "utf-8");
  }

  citation(path: string, lines?: LineRange): string {
    return formatCitation(this.citationFormat, {
      source: this.id,
      rev: this.pinnedRevision ?? UNPINNED_REVISION,
      path,
      lines,
    });
  }

  /**
   * Revision used when rendering citations.
   *
   * A citation must name the revision the claim was verified against, not
   * whatever the tree hashes to when the page is rendered later.
   */
  private pinnedRevision: string | undefined;

  pinRevision(revision: string): void {
    this.pinnedRevision = revision;
  }

  private scan(): Entry[] {
    const out: Entry[] = [];
    this.walk(this.root, out);
    out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return out;
  }

  private walk(dir: string, into: Entry[]): void {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
        this.walk(full, into);
        continue;
      }
      if (!entry.isFile()) continue;
      if (this.extensions.length > 0 && !this.extensions.some((e) => entry.name.endsWith(e))) {
        continue;
      }
      const path = relative(this.root, full);
      into.push({
        path: sep === "/" ? path : path.split(sep).join("/"),
        mtimeMs: statSync(full).mtimeMs,
      });
    }
  }
}
