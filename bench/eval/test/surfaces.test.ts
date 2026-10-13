import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runSurfaces } from "../surfaces.ts";
import { sha256 } from "../lib/answers.ts";
import { claudeArgs, dryAgent, readArms } from "../lib/agent.ts";
import { succeeded, validateTasks } from "../lib/surfaces.ts";

const FIXTURES = join(import.meta.dir, "fixtures");
const SESSION = {
  arm: "a",
  item: "t",
  result: "",
  is_error: false,
  num_turns: 1,
  total_cost_usd: 0,
  usage: {
    input_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    output_tokens: 0,
  },
};
const arms = readArms(join(FIXTURES, "arms.json"));
const arm = (id: string) => arms.find((a) => a.id === id)!;

test("each arm's command gives the agent only its surface", () => {
  const mcp = claudeArgs(arm("mcp-only"));
  expect(mcp).toContain("--strict-mcp-config");
  expect(mcp[mcp.indexOf("--tools") + 1]).toBe("");
  expect(mcp[mcp.indexOf("--mcp-config") + 1]).toBe(join(FIXTURES, "mcp.json"));
  const cli = claudeArgs(arm("cli-only"));
  expect(cli).not.toContain("--mcp-config");
  expect(cli[cli.indexOf("--allowedTools") + 1]).toBe("Bash(accreta:*)");
  expect(claudeArgs(arm("closed-book"))).not.toContain("--allowedTools");
  expect(arm("repo-tools").cwd).toBe(join(FIXTURES, "repo"));
});

test("a dry run with no canned session fails loudly rather than scoring a blank", async () => {
  await expect(dryAgent({})(arm("cli-only"), "t1", "")).rejects.toThrow(/no canned session/);
});

test("tasks need a pattern that compiles; a reject pattern fails an answer that matches", () => {
  expect(() => validateTasks([{ id: "t", prompt: "p", expect: ["("] }])).toThrow(/bad pattern/);
  expect(() => validateTasks([{ id: "t", prompt: "p", expect: ["a"], reject: ["["] }])).toThrow(
    /bad pattern/,
  );
  const task = { id: "t", prompt: "p", expect: ["routing"], reject: ["not .*routing"] };
  const said = (result: string) => ({ ...SESSION, result });
  expect(succeeded(task, said("knowledge/routing.md"))).toBe(true);
  expect(succeeded(task, said("it is not knowledge/routing.md"))).toBe(false);
});

test("dry run: CLI-only against MCP-only, success and tokens", async () => {
  const s = await runSurfaces({
    tasks: join(FIXTURES, "tasks.json"),
    arms: join(FIXTURES, "arms.json"),
    a: "cli-only",
    b: "mcp-only",
    canned: join(FIXTURES, "surfaces-canned.json"),
  });
  expect(s.arms["cli-only"]!.success).toMatchObject({ k: 2, n: 3 });
  expect(s.arms["mcp-only"]!.success).toMatchObject({ k: 3, n: 3 });
  expect(s.arms["cli-only"]!.tokens).toMatchObject({ n: 3, median: 11910 });
  expect(s.arms["mcp-only"]!.turns.mean).toBeCloseTo(7 / 3);
  expect(s.mcnemar).toMatchObject({ b: 0, c: 1, pTwoSided: 1 });
  expect(s.tokenRatio.perTask.n).toBe(3);
  expect(s.tokenRatio.ofTotals).toBeCloseTo(26280 / 35730, 9);
  expect(s.tokenRatio.geometricMean).toBeLessThan(s.tokenRatio.perTask.max);
  expect(s.inference).toBe("descriptive only");
  const live = {
    tasks: join(FIXTURES, "tasks.json"),
    arms: join(FIXTURES, "arms.json"),
    a: "cli-only",
    b: "mcp-only",
    live: true,
  };
  await expect(runSurfaces({ ...live, tasksSha256: "0" })).rejects.toThrow(/tasks-sha256/);
  const tasksSha256 = sha256(readFileSync(live.tasks));
  await expect(runSurfaces({ ...live, tasksSha256 })).rejects.toThrow(/20 registered tasks/);
});
