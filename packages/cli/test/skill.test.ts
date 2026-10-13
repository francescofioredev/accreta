import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSources, readDeclarationFiles } from "@accreta/adapters";
import { COMMAND_ARGS } from "../src/commands/shared.ts";

const SKILL = readFileSync(
  new URL("../../../skills/accreta-setup/SKILL.md", import.meta.url),
  "utf-8",
);

// Each invocation: a line in a code block, or inline code, that starts with `accreta `.
const blocks = [...SKILL.matchAll(/^```[a-z]*\n([\s\S]*?)^```/gm)].flatMap((m) =>
  m[1]!.split("\n"),
);
const inline = [...SKILL.matchAll(/`(accreta [^`]+)`/g)].map((m) => m[1]!);
const invocations = [...blocks, ...inline]
  .map((line) => line.match(/^accreta ([a-z][a-z-]*)(.*)$/))
  .filter((m): m is RegExpMatchArray => m !== null)
  .map(([, command, rest]) => ({
    command: command!,
    // A shell comment starts at " #"; a "#" inside a target is its locator.
    flags: rest!.replace(/\s#\s.*$/, "").match(/--[a-z-]+/g) ?? [],
  }));

test("every command the setup skill runs is one the CLI has", () => {
  const unknown = invocations
    .map(({ command }) => command)
    .filter((command) => !Object.hasOwn(COMMAND_ARGS, command));
  expect(unknown).toEqual([]);
});

test("every flag the setup skill passes is one its command takes", () => {
  const wrong = invocations.flatMap(({ command, flags }) =>
    flags
      .filter((flag) => !(COMMAND_ARGS[command]?.flags.includes(flag) ?? false))
      .map((flag) => `${command} ${flag}`),
  );
  expect(wrong).toEqual([]);
});

test("the working loops are in the skill", () => {
  expect(invocations.map(({ command }) => command)).toEqual(
    expect.arrayContaining(["cite", "drift", "canonical", "search", "show"]),
  );
  expect(SKILL).toContain("--expect-revision");
});

test("the git source example declares paths and loads through the sources/ loader", () => {
  const example = [...SKILL.matchAll(/^```yaml\n([\s\S]*?)^```/gm)]
    .map((m) => m[1]!)
    .find((yaml) => /^type: git$/m.test(yaml));
  expect(example).toBeDefined();

  const root = mkdtempSync(join(tmpdir(), "accreta-skill-"));
  try {
    mkdirSync(join(root, "sources"));
    writeFileSync(join(root, "sources", "example.yaml"), example!, "utf-8");
    const [entry] = readDeclarationFiles(root);
    if (!entry || "error" in entry) throw new Error(`did not parse: ${JSON.stringify(entry)}`);
    const { paths } = entry.declaration.options;
    expect(Array.isArray(paths) && paths.length > 0).toBe(true);
    expect((paths as unknown[]).every((p) => typeof p === "string" && p.length > 0)).toBe(true);

    const { sources, unloaded } = loadSources({
      root,
      citationFormat: "{source} @ {rev}",
      stateDir: join(root, ".accreta"),
    });
    expect(unloaded).toEqual([]);
    expect([...sources.keys()]).toEqual([entry.declaration.id]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
