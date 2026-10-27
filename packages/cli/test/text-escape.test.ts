import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/main.ts";

// ESC, a right-to-left override, a zero-width space and a tag character: raw, as YAML spells
// them, and as the text output must show them.
const RAW = "\u001b[2J\u202e\u200b\u{e0041}";
const YAML = "\\e[2J\\u202e\\u200b\\U000E0041";
const SHOWN = "\\u001b[2J\\u202e\\u200b\\u{e0041}";
const UNSAFE = /[\p{Cc}\p{Cf}\u2028\u2029]/u;

let root = "";
let output: string[] = [];
let errors: string[] = [];

async function cli(...argv: string[]): Promise<number> {
  return run(argv, {
    cwd: root,
    out: (line) => output.push(line),
    err: (line) => errors.push(line),
  });
}

/** Every printed line, split where a printed value broke it. */
const lines = () => output.flatMap((line) => line.split("\n"));
const unsafe = () => lines().filter((line) => UNSAFE.test(line));
const unsafeErrors = () => errors.filter((line) => UNSAFE.test(line));

/** What run() threw, as main() would print it. */
async function thrown(...argv: string[]): Promise<string> {
  try {
    await cli(...argv);
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("expected the command to throw");
}

const HOSTILE_PAGE = `---
type: note
title: "Title${YAML}"
aliases: ["hostile"]
canonical_source: "src${YAML}"
last_verified_revision: "rev${YAML}"
related: ["[[hub]]", "[[gone${YAML}]]"]
---

# Heading

first line \u001b[31m \u202ereversed \u2066isolate\u2069
second line tropopause
`;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "accreta-text-escape-"));
  output = [];
  errors = [];
  delete process.env.ACCRETA_INDEX_PATH;
  delete process.env.ACCRETA_ROOT;
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("text output against a page that carries control and format characters", () => {
  beforeEach(async () => {
    await cli("init");
    mkdirSync(join(root, "knowledge"), { recursive: true });
    writeFileSync(join(root, "knowledge", `evil${RAW}.md`), HOSTILE_PAGE);
    writeFileSync(join(root, "knowledge", "hub.md"), "---\ntype: note\n---\n\n# Hub\n");
    await cli("reindex");
    output = [];
  });

  test("lint escapes a finding's path and detail", async () => {
    expect(await cli("lint")).toBe(1);
    expect(lines()).toContain(
      `  knowledge/evil${SHOWN}.md: knowledge/gone${SHOWN}.md (related) is linked but no such page exists`,
    );
    expect(unsafe()).toEqual([]);
  });

  test("search escapes a hit's path, title and snippet", async () => {
    expect(await cli("search", "tropopause")).toBe(0);
    expect(lines()).toContain(`knowledge/evil${SHOWN}.md  [note]`);
    expect(lines()).toContain(`  Title${SHOWN}`);
    expect(lines().join("\n")).toContain("\\u001b[31m \\u202ereversed \\u2066isolate\\u2069");
    expect(unsafe()).toEqual([]);
  });

  test("canonical escapes a match's path and canonical source", async () => {
    expect(await cli("canonical", "hostile")).toBe(0);
    expect(lines()).toContain(`knowledge/evil${SHOWN}.md  [note]  (matched on alias)`);
    expect(lines()).toContain(`  source: src${SHOWN}`);
    expect(unsafe()).toEqual([]);
  });

  test("consumers escapes a relation's path and title", async () => {
    expect(await cli("consumers", "hub")).toBe(0);
    expect(lines()).toContain(`← knowledge/evil${SHOWN}.md  [related]  Title${SHOWN}`);
    expect(unsafe()).toEqual([]);
  });

  test("show escapes the metadata and keeps the body's lines", async () => {
    expect(await cli("show", `evil${RAW}`)).toBe(0);
    expect(lines().slice(0, 5)).toEqual([
      `# Title${SHOWN}`,
      `path: knowledge/evil${SHOWN}.md`,
      "type: note",
      `canonical_source: src${SHOWN}`,
      `verified at: rev${SHOWN}`,
    ]);
    expect(lines()).toContain("first line \\u001b[31m \\u202ereversed \\u2066isolate\\u2069");
    expect(lines()).toContain("second line tropopause");
    expect(unsafe()).toEqual([]);
  });

  test("lint prints two pages a variation selector tells apart as two paths", async () => {
    writeFileSync(join(root, "knowledge", "auth.md"), "---\ntype: note\n---\n\n[[nowhere]]\n");
    writeFileSync(
      join(root, "knowledge", "auth\ufe0f.md"),
      "---\ntype: note\n---\n\n[[nowhere]]\n",
    );
    await cli("reindex");
    output = [];
    expect(await cli("lint")).toBe(1);
    const auth = lines().filter((line) => line.startsWith("  knowledge/auth"));
    expect(auth.some((line) => line.startsWith("  knowledge/auth.md:"))).toBe(true);
    expect(auth.some((line) => line.startsWith("  knowledge/auth\\ufe0f.md:"))).toBe(true);
  });

  test("--json stays raw", async () => {
    expect(await cli("show", `evil${RAW}`, "--json")).toBe(0);
    const { page } = JSON.parse(output.join("\n")) as { page: { title: string } };
    expect(page.title).toBe(`Title${RAW}`);
  });
});

describe("cite's text output against a declaration that carries them", () => {
  beforeEach(() => {
    writeFileSync(join(root, "accreta.config.yaml"), "knowledge_base: knowledge\n", "utf-8");
    mkdirSync(join(root, "sources"), { recursive: true });
    writeFileSync(
      join(root, "sources", "wiki.yaml"),
      `id: wiki\ntype: delegated\nvia: "notion${YAML}"\n` +
        'scope: "Design pages.\\nsecond\\e[2J\\u202e line\\u2028footnote: forged\\u2029revision: forged"\n',
    );
  });

  test("escapes via and the target, and keeps the scope's lines indented", async () => {
    expect(await cli("cite", `wiki:page${RAW}`)).toBe(0);
    expect(lines()).toContain(`canonical_source: wiki:page${SHOWN}`);
    expect(lines().slice(4)).toEqual([
      `delegated: read through notion${SHOWN}; scope:`,
      "  Design pages.",
      "  second\\u001b[2J\\u202e line\\u2028footnote: forged\\u2029revision: forged",
    ]);
    expect(lines().join("\n")).toContain(`read through notion${SHOWN}; accreta cannot check it`);
    expect(lines().filter((line) => /^(footnote|revision):/.test(line))).toHaveLength(2);
    expect(unsafe()).toEqual([]);
  });

  test("an unknown source escapes every configured id", async () => {
    writeFileSync(
      join(root, "sources", "evil.yaml"),
      `id: "evil${YAML}"\ntype: delegated\nvia: notion\nscope: "x"\n`,
    );
    expect(await cli("cite", "nosuch:a.md")).toBe(2);
    expect(errors.join("\n")).toContain(`Configured sources: evil${SHOWN}, wiki.`);
    expect(unsafeErrors()).toEqual([]);
  });

  test("an expected revision it cannot confirm is escaped", async () => {
    const message = await thrown("cite", "wiki:page.md", "--expect-revision", `rev${RAW}`);
    expect(message).toContain(`still at rev${SHOWN}:`);
    expect(UNSAFE.test(message)).toBe(false);
  });

  test("two sources named against one expected revision are escaped", async () => {
    expect(await cli("cite", `x${RAW}:a.md`, "wiki:b.md", "--expect-revision", "r")).toBe(2);
    expect(errors.join("\n")).toContain(`the targets name x${SHOWN}, wiki.`);
    expect(unsafeErrors()).toEqual([]);
  });

  test("an unknown --format value is escaped", async () => {
    expect(await cli("cite", "wiki:a.md", "--format", `x${RAW}`)).toBe(2);
    expect(errors.join("\n")).toContain(`not "x${SHOWN}"`);
    expect(unsafeErrors()).toEqual([]);
  });
});
