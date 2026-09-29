import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, type AccretaConfig } from "../src/config.ts";
import { buildIndex } from "../src/index-db/build.ts";
import { openIndex, type Database } from "../src/index-db/db.ts";
import { lint } from "../src/query/lint.ts";

let root = "";
let indexPath = "";
let db: Database | undefined;

const config: AccretaConfig = { ...DEFAULT_CONFIG, pageTypes: ["note"] };

function writePage(name: string, fields: Record<string, string> = {}): void {
  const extra = Object.entries(fields)
    .map(([key, value]) => `${key}: ${value}\n`)
    .join("");
  const full = join(root, "knowledge", `${name}.md`);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(
    full,
    `---\ntype: note\ncanonical_source: "s:${name}.txt#L1"\nlast_verified_revision: abc\n${extra}---\n\n# ${name}\n`,
  );
}

function supersessionFindings(with_: AccretaConfig = config) {
  db?.close();
  buildIndex({ root, config: with_, indexPath });
  db = openIndex(indexPath, { readonly: true });
  return lint(db, with_).findings.filter((f) => f.kind === "inconsistent-supersession");
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "accreta-supersession-"));
  indexPath = join(root, ".index", "accreta.sqlite");
  db = undefined;
});

afterEach(() => {
  db?.close();
  rmSync(root, { recursive: true, force: true });
});

describe("inconsistent-supersession", () => {
  // The knowledge base from issue #81: each page claims to replace the other, and lint was clean.
  test("two pages that each supersede the other are one finding", () => {
    writePage("a", { supersedes: "[[b]]", superseded_by: "[[b]]" });
    writePage("b", { supersedes: "[[a]]", superseded_by: "[[a]]" });

    const findings = supersessionFindings();

    expect(findings).toHaveLength(1);
    expect(findings[0]!.path).toBe("knowledge/a.md");
    expect(findings[0]!.detail).toContain("knowledge/a.md");
    expect(findings[0]!.detail).toContain("knowledge/b.md");
  });
});
