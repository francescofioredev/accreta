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

// Through the bin, so what a command throws is printed by main()'s catch-all.
const BIN = [
  process.execPath,
  "--conditions=@accreta/source",
  join(import.meta.dir, "..", "src", "bin.ts"),
];

/** A run through the bin: its exit code and its stderr, as lines. */
function spawned(env: Record<string, string>, ...argv: string[]) {
  const base = { ...process.env };
  delete base.ACCRETA_INDEX_PATH;
  delete base.ACCRETA_ROOT;
  const proc = Bun.spawnSync([...BIN, ...argv], { cwd: root, env: { ...base, ...env } });
  return { code: proc.exitCode, stderr: proc.stderr.toString().trimEnd().split("\n") };
}
const unsafeIn = (stderr: string[]) => stderr.filter((line) => UNSAFE.test(line));
// A CI runner reads `::command::` after leading whitespace, or the line poses as one of ours.
const forgedLines = (printed: string[], start = "::") =>
  printed.filter((line) => line.trimStart().startsWith(start));

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
        'scope: "Design pages.\\nsecond\\e[2J\\u202e\\u200b\\U000E0041 line\\u2028footnote: forged\\u2029revision: forged"\n',
    );
  });

  test("escapes via and the target, and keeps the scope's lines indented", async () => {
    expect(await cli("cite", `wiki:page${RAW}`)).toBe(0);
    expect(lines()).toContain(`canonical_source: wiki:page${SHOWN}`);
    expect(lines().slice(4)).toEqual([
      `delegated: read through notion${SHOWN}; scope:`,
      "  Design pages.",
      "  second\\u001b[2J\\u202e\\u200b\\u{e0041} line\\u2028footnote: forged\\u2029revision: forged",
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

  test("an expected revision it cannot confirm is escaped once", () => {
    const { code, stderr } = spawned({}, "cite", "wiki:page.md", "--expect-revision", `rev${RAW}`);
    expect(code).toBe(1);
    expect(stderr.join("\n")).toContain(`still at rev${SHOWN}:`);
    expect(unsafeIn(stderr)).toEqual([]);
  });

  test("a source that moved is escaped once in the target it names", () => {
    mkdirSync(join(root, "sources", "docs"), { recursive: true });
    writeFileSync(join(root, "sources", "docs", "a.md"), "text\n");
    writeFileSync(join(root, "sources", "docs.yaml"), "id: docs\ntype: fs\nroot: sources/docs\n");
    const { code, stderr } = spawned({}, "cite", `docs:a${RAW}.md`, "--expect-revision", "bogus");
    expect(code).toBe(1);
    expect(stderr.join("\n")).toContain(`Re-read docs:a${SHOWN}.md,`);
    expect(unsafeIn(stderr)).toEqual([]);
  });

  test("a source that did not load is escaped once", () => {
    writeFileSync(join(root, "sources", "broken.yaml"), `id: broken\ntype: "fs${YAML}"\n`);
    const { code, stderr } = spawned({}, "cite", "broken:a.md");
    expect(code).toBe(1);
    expect(stderr.join("\n")).toContain(`Unknown source type "fs${SHOWN}"`);
    expect(unsafeIn(stderr)).toEqual([]);
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

describe("doctor against declarations that carry them", () => {
  beforeEach(() => {
    writeFileSync(join(root, "accreta.config.yaml"), "knowledge_base: knowledge\n", "utf-8");
    mkdirSync(join(root, "sources"), { recursive: true });
  });

  test("escapes a declaration's file, id and type", async () => {
    writeFileSync(
      join(root, "sources", `evil${RAW}.yaml`),
      `id: "evil${YAML}"\ntype: "fs${YAML}"\n`,
    );
    expect(await cli("doctor")).toBe(1);
    expect(lines()).toContain(`  evil${SHOWN} — fs${SHOWN} — sources/evil${SHOWN}.yaml`);
    expect(unsafe()).toEqual([]);
  });

  test("escapes why a file is not a declaration", async () => {
    writeFileSync(join(root, "sources", "bad.yaml"), `id: "bad${YAML}"\n`);
    expect(await cli("doctor")).toBe(1);
    expect(lines().join("\n")).toContain(`not a source declaration — Source "bad${SHOWN}"`);
    expect(unsafe()).toEqual([]);
  });

  test("escapes an id two files declare, and the other file", async () => {
    const twin = `id: "twin${YAML}"\ntype: delegated\nvia: notion\nscope: x\n`;
    writeFileSync(join(root, "sources", "a.yaml"), twin);
    writeFileSync(join(root, "sources", `b${RAW}.yaml`), twin);
    expect(await cli("doctor")).toBe(1);
    expect(lines()).toContain(
      `    no: id \`twin${SHOWN}\` is also declared in sources/b${SHOWN}.yaml`,
    );
    expect(unsafe()).toEqual([]);
  });

  test("escapes the preflight's detail, connector and hint", async () => {
    writeFileSync(
      join(root, "sources", "wiki.yaml"),
      `id: wiki\ntype: delegated\nvia: "notion${YAML}"\nscope: x\n`,
    );
    await cli("doctor");
    expect(lines()).toContain(`    unknown: accreta cannot check this source; notion${SHOWN} can`);
    expect(lines()).toContain(`    your agent needs: notion${SHOWN} — unverified`);
    expect(lines().join("\n")).toContain(`whether your agent can reach notion${SHOWN}.`);
    expect(unsafe()).toEqual([]);
  });

  test("marks every line of a multi-line preflight detail", async () => {
    writeFileSync(
      join(root, "sources", "docs.yaml"),
      'id: docs\ntype: fs\nroot: "nope\\n::warning::forged"\n',
    );
    expect(await cli("doctor")).toBe(1);
    expect(forgedLines(lines())).toEqual([]);
    expect(lines()).toContain("      | ::warning::forged does not exist");
  });

  test("escapes the config's parse error and marks its code frame", async () => {
    writeFileSync(
      join(root, "accreta.config.yaml"),
      "knowledge_base: knowledge\n::warning::forged\u001b[2J: [\n",
    );
    expect(await cli("doctor")).toBe(1);
    expect(forgedLines(lines())).toEqual([]);
    expect(lines()).toContain("    | ::warning::forged\\u001b[2J: [");
    expect(unsafe()).toEqual([]);
  });

  test("escapes an unreadable provenance.format", async () => {
    writeFileSync(
      join(root, "accreta.config.yaml"),
      `knowledge_base: knowledge\nprovenance:\n  format: "{source}${YAML}"\n`,
    );
    expect(await cli("doctor")).toBe(1);
    expect(lines().join("\n")).toContain(`unreadable: provenance.format "{source}${SHOWN}"`);
    expect(unsafe()).toEqual([]);
  });

  test("escapes why an installed skill's floor cannot be read", async () => {
    mkdirSync(join(root, ".git"));
    mkdirSync(join(root, ".claude", "skills", "accreta-setup"), { recursive: true });
    writeFileSync(
      join(root, ".claude", "skills", "accreta-setup", "SKILL.md"),
      '---\nname: accreta-setup\nmetadata:\n  requires: "1\\u202e\\N"\n---\n',
    );
    await cli("doctor");
    expect(lines().join("\n")).toContain('metadata.requires is "1\\u202e\\u0085", not a release');
    expect(unsafe()).toEqual([]);
  });
});

describe("source add against values that carry them", () => {
  beforeEach(() => {
    writeFileSync(join(root, "accreta.config.yaml"), "knowledge_base: knowledge\n", "utf-8");
  });

  test("escapes what the preflight reports", async () => {
    const via = `via="notion${YAML}"`;
    expect(await cli("source", "add", "delegated", "wiki", "--set", via, "--set", "scope=x")).toBe(
      0,
    );
    expect(lines()).toContain(`  unknown: accreta cannot check this source; notion${SHOWN} can`);
    expect(unsafe()).toEqual([]);
  });

  test("escapes the id it echoes", async () => {
    // The id goes into the YAML unquoted, so reading it back may throw; the echo comes first.
    await cli("source", "add", "fs", `w${RAW}`).catch(() => 1);
    expect(lines()).toContain(`Wrote sources/w${SHOWN}.yaml`);
    expect(unsafe()).toEqual([]);
  });

  test("escapes an unknown type", async () => {
    expect(await cli("source", "add", `fs${RAW}`, "wiki")).toBe(2);
    expect(errors.join("\n")).toContain(`Unknown source type "fs${SHOWN}".`);
    expect(unsafeErrors()).toEqual([]);
  });
});

describe("the CLI's catch-all", () => {
  test("escapes a thrown message line by line and marks each continuation", () => {
    const { code, stderr } = spawned({ ACCRETA_ROOT: join(root, `evil${RAW}\nforged`) }, "lint");
    expect(code).toBe(1);
    expect(stderr).toEqual([`No accreta.config.yaml at ${root}/evil${SHOWN}`, "  | forged"]);
  });

  // Windows refuses a newline in a file name.
  test.skipIf(process.platform === "win32")(
    "a declaration file name cannot start a line of its own",
    () => {
      writeFileSync(join(root, "accreta.config.yaml"), "knowledge_base: knowledge\n", "utf-8");
      mkdirSync(join(root, "sources"), { recursive: true });
      writeFileSync(join(root, "sources", "evil\nok: forged.yaml"), "id: broken\ntype: nosuch\n");
      const { code, stderr } = spawned({}, "cite", "broken:a.md");
      expect(code).toBe(1);
      expect(forgedLines(stderr, "ok:")).toEqual([]);
      expect(stderr.some((line) => line.startsWith("  | ok: forged.yaml"))).toBe(true);
    },
  );
});

describe("drift's refusal of its arguments", () => {
  beforeEach(async () => {
    writeFileSync(join(root, "accreta.config.yaml"), "knowledge_base: knowledge\n", "utf-8");
    mkdirSync(join(root, "knowledge"), { recursive: true });
    await cli("reindex");
  });

  test("escapes an unknown --format value", async () => {
    expect(await cli("drift", "--format", `x${RAW}`)).toBe(2);
    expect(errors.join("\n")).toContain(`not "x${SHOWN}".`);
    expect(unsafeErrors()).toEqual([]);
  });

  test("escapes a --base report's source once", async () => {
    writeFileSync(join(root, "base.json"), JSON.stringify({ source: `x${RAW}`, sources: [] }));
    expect(await cli("drift", "--base", "base.json")).toBe(2);
    expect(errors.join("\n")).toContain(`only source "x${SHOWN}"; add --source x${SHOWN}.`);
    expect(unsafeErrors()).toEqual([]);
  });

  test("a --base report's source cannot start a line of its own", async () => {
    const source = "a\n::warning::forged";
    writeFileSync(join(root, "base.json"), JSON.stringify({ source, sources: [] }));
    expect(await cli("drift", "--base", "base.json")).toBe(2);
    const printed = errors.flatMap((line) => line.split("\n"));
    expect(forgedLines(printed)).toEqual([]);
    expect(printed).toContain('  | ::warning::forged"; add --source a');
  });
});

describe("drift's text output against a delegated scope", () => {
  test("prints the scope as cite does: indentation, joiners and tabs kept, CRLF one break", async () => {
    writeFileSync(join(root, "accreta.config.yaml"), "knowledge_base: knowledge\n", "utf-8");
    mkdirSync(join(root, "knowledge"), { recursive: true });
    mkdirSync(join(root, "sources"), { recursive: true });
    writeFileSync(
      join(root, "sources", "wiki.yaml"),
      'id: wiki\ntype: delegated\nvia: notion\nscope: "  Design pages.\\r\\nsecond\\tline \\u200d joined\\e[2J\\u202e\\u200b\\U000E0041\\u2028x\\n"\n',
    );
    await cli("reindex");
    output = [];
    await cli("drift");
    const at = lines().indexOf("  in scope:");
    expect(at).toBeGreaterThan(-1);
    expect(lines().slice(at + 1)).toEqual([
      "      Design pages.",
      "    second\tline \u200d joined\\u001b[2J\\u202e\\u200b\\u{e0041}\\u2028x",
    ]);
  });
});
