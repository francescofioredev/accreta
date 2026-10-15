import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { git } from "../lib/git.ts";

export const lines = (n: number, edits: Record<number, string> = {}) =>
  Array.from({ length: n }, (_, i) => edits[i + 1] ?? `line ${i + 1}`).join("\n") + "\n";

export function write(root: string, path: string, text: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text, "utf-8");
}

export function repo(dir: string, files: Record<string, string>): string {
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "t@example.invalid");
  git(dir, "config", "user.name", "Test");
  git(dir, "config", "commit.gpgsign", "false");
  for (const [path, text] of Object.entries(files)) write(dir, path, text);
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "pin");
  return git(dir, "rev-parse", "HEAD").trim();
}

export function commit(dir: string, message: string): string {
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", message);
  return git(dir, "rev-parse", "HEAD").trim();
}

/** A knowledge base in a fresh temp directory, with the default provenance format. */
export function kbDir(): string {
  const root = mkdtempSync(join(tmpdir(), "accreta-eval-kb-"));
  write(
    root,
    "accreta.config.yaml",
    'knowledge_base: knowledge\npage_types: [concept, module]\nprovenance:\n  format: "{source} @ {rev} · {path}#{locator}"\n',
  );
  return root;
}

export function page(
  root: string,
  name: string,
  opts: { source?: string; verified?: string; canonical?: string; body: string },
): void {
  const front = ["---", "type: concept"];
  if (opts.source) front.push(`source: ${opts.source}`);
  if (opts.verified) front.push(`last_verified_revision: ${opts.verified}`);
  if (opts.canonical) front.push(`canonical_source: ${opts.canonical}`);
  front.push("---", "");
  write(root, `knowledge/${name}.md`, `${front.join("\n")}\n# ${name}\n\n${opts.body}\n`);
}

export const declareGit = (root: string, id: string, sourceRoot: string) =>
  write(root, `sources/${id}.yaml`, `id: ${id}\ntype: git\nroot: ${sourceRoot}\n`);
