import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
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
