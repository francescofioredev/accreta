#!/usr/bin/env bun
/**
 * T3, tier C: every citation the tier C ingest wrote into got v13.0.0, moved to v14.4.0.
 * Deterministic facts per citation: which diff hunks touch the cited range, where the range lands in
 * v14.4.0, and what happened to the innermost TypeScript declaration that encloses it.
 * The claim-level label (does the claim still hold?) is not deterministic and comes from annotators.
 */
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { DATA } from "../lib/paths.ts";
import { FROM_TAG, RUNS, RUNS_DIR, TO_TAG } from "../tasks/ingest-got.ts";

const REPO_DIR = join(RUNS_DIR, "run1", "repo");
const CITE = /^\[\^([^\]]+)\]:\s*got @ [0-9a-f]+ · (source\/[^#\s]+)#L(\d+)(?:-L(\d+))?/;
const show = (tag: string, path: string) => {
  try {
    return execFileSync("git", ["-C", REPO_DIR, "show", `${tag}:${path}`]).toString();
  } catch {
    return null;
  }
};

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) =>
    statSync(join(dir, f)).isDirectory()
      ? walk(join(dir, f))
      : f.endsWith(".md")
        ? [join(dir, f)]
        : [],
  );
}
function claimsFor(body: string, name: string): string[] {
  const marker = `[^${name}]`;
  return body
    .split(/\n\s*\n/)
    .filter((p) => p.includes(marker) && !p.trimStart().startsWith("[^"))
    .flatMap((p) => p.replace(/\s+/g, " ").split(/(?<=[.!?])\s+(?=[A-Z`*"(])/))
    .filter((s) => s.includes(marker))
    .map((s) => s.replace(/\[\^[^\]]+\]/g, "").trim());
}

interface Hunk {
  oldStart: number;
  oldLen: number;
  newStart: number;
  newLen: number;
}
function hunks(path: string): Hunk[] {
  const out = execFileSync("git", [
    "-C",
    REPO_DIR,
    "diff",
    "-U0",
    FROM_TAG,
    TO_TAG,
    "--",
    path,
  ]).toString();
  return [...out.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)].map((m) => ({
    oldStart: +m[1]!,
    oldLen: m[2] === undefined ? 1 : +m[2],
    newStart: +m[3]!,
    newLen: m[4] === undefined ? 1 : +m[4],
  }));
}
/** A pure insertion (oldLen 0) sits after oldStart; it touches a range that spans that gap. */
const touches = (h: Hunk, a: number, b: number) =>
  h.oldLen === 0
    ? a <= h.oldStart && h.oldStart < b
    : h.oldStart <= b && h.oldStart + h.oldLen - 1 >= a;
function mapLine(hs: Hunk[], line: number): number {
  let shift = 0;
  for (const h of hs) {
    const end = h.oldStart + Math.max(h.oldLen, 1) - 1;
    if (h.oldLen > 0 && line >= h.oldStart && line <= end)
      return h.newStart + Math.min(line - h.oldStart, Math.max(h.newLen - 1, 0));
    if ((h.oldLen === 0 ? h.oldStart : end) < line) shift += h.newLen - h.oldLen;
  }
  return line + shift;
}

/** Innermost named declaration enclosing the range, as a dotted path, with its normalised text. */
function declarations(text: string): { path: string; start: number; end: number; norm: string }[] {
  const sf = ts.createSourceFile("x.ts", text, ts.ScriptTarget.Latest, true);
  const out: { path: string; start: number; end: number; norm: string }[] = [];
  const nameOf = (n: ts.Node): string | undefined => {
    const name = (n as any).name;
    if (name && ts.isIdentifier(name)) return name.text;
    if (name && (ts.isStringLiteral(name) || ts.isPrivateIdentifier(name))) return name.text;
    if (ts.isVariableStatement(n))
      return n.declarationList.declarations
        .map((d) => (ts.isIdentifier(d.name) ? d.name.text : "?"))
        .join(",");
    if (ts.isConstructorDeclaration(n)) return "constructor";
    return undefined;
  };
  const visit = (n: ts.Node, prefix: string) => {
    const name = nameOf(n);
    const isDecl =
      name &&
      (ts.isFunctionDeclaration(n) ||
        ts.isClassDeclaration(n) ||
        ts.isInterfaceDeclaration(n) ||
        ts.isTypeAliasDeclaration(n) ||
        ts.isEnumDeclaration(n) ||
        ts.isVariableStatement(n) ||
        ts.isMethodDeclaration(n) ||
        ts.isPropertyDeclaration(n) ||
        ts.isPropertySignature(n) ||
        ts.isMethodSignature(n) ||
        ts.isGetAccessor(n) ||
        ts.isSetAccessor(n) ||
        ts.isConstructorDeclaration(n));
    const path = isDecl ? (prefix ? `${prefix}.${name}` : name!) : prefix;
    if (isDecl) {
      const start = sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
      const end = sf.getLineAndCharacterOfPosition(n.getEnd()).line + 1;
      const norm = n
        .getText(sf)
        .replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "")
        .replace(/\s+/g, "");
      out.push({ path, start, end, norm });
    }
    ts.forEachChild(n, (c) => visit(c, path));
  };
  visit(sf, "");
  return out;
}

if (import.meta.main) {
  const seen = new Set<string>();
  const items: any[] = [];
  const cache = new Map<string, any>();
  for (let run = 1; run <= RUNS; run++) {
    const kb = join(RUNS_DIR, `run${run}`, "kb", "knowledge");
    for (const file of walk(kb)) {
      const body = readFileSync(file, "utf8").replace(/^---[\s\S]*?---/, "");
      for (const line of body.split("\n")) {
        const m = line.match(CITE);
        if (!m) continue;
        const [path, start] = [m[2]!, +m[3]!];
        const end = +(m[4] ?? start);
        for (const claim of claimsFor(body, m[1]!)) {
          const key = `${path}#${start}-${end}\0${claim}`;
          if (seen.has(key) || claim.length < 20) continue;
          seen.add(key);
          if (!cache.has(path)) {
            const before = show(FROM_TAG, path);
            const after = show(TO_TAG, path);
            cache.set(path, {
              before,
              after,
              hunks: hunks(path),
              declsBefore: before ? declarations(before) : [],
              declsAfter: after ? declarations(after) : [],
            });
          }
          const f = cache.get(path)!;
          if (!f.before) continue;
          const touching = f.hunks.filter((h: Hunk) => touches(h, start, end));
          const enclosing = f.declsBefore
            .filter((d: any) => d.start <= start && d.end >= end)
            .sort((a: any, b: any) => a.end - a.start - (b.end - b.start))[0];
          const successor = enclosing
            ? f.declsAfter.find((d: any) => d.path === enclosing.path)
            : undefined;
          items.push({
            id: `c${items.length + 1}`,
            run,
            page: file.slice(kb.length + 1),
            path,
            start,
            end,
            claim,
            file_changed: f.hunks.length > 0 || !f.after,
            touched: touching.length > 0 || !f.after,
            new_start: f.after ? mapLine(f.hunks, start) : null,
            new_end: f.after ? mapLine(f.hunks, end) : null,
            declaration: enclosing?.path ?? null,
            declaration_fate: !enclosing
              ? "none"
              : !successor
                ? "removed"
                : successor.norm === enclosing.norm
                  ? "unchanged"
                  : "changed",
          });
        }
      }
    }
  }
  writeFileSync(
    join(DATA, "t3-got.json"),
    JSON.stringify({ from: FROM_TAG, to: TO_TAG, items }) + "\n",
  );
  const count = (f: (x: any) => boolean) => items.filter(f).length;
  console.log({
    citations: items.length,
    in_changed_file: count((x) => x.file_changed),
    touched: count((x) => x.touched),
    fate: Object.fromEntries(
      ["unchanged", "changed", "removed", "none"].map((k) => [
        k,
        count((x) => x.declaration_fate === k),
      ]),
    ),
    touched_fate: Object.fromEntries(
      ["unchanged", "changed", "removed", "none"].map((k) => [
        k,
        count((x) => x.touched && x.declaration_fate === k),
      ]),
    ),
  });
}
