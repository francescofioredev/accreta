import { expect, test } from "bun:test";
import { join } from "node:path";
import { runSurfaces } from "../surfaces.ts";
import { claudeArgs, dryAgent, readArms } from "../lib/agent.ts";
import { validateTasks } from "../lib/surfaces.ts";

const FIXTURES = join(import.meta.dir, "fixtures");
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

test("tasks need a pattern that compiles", () => {
  expect(() => validateTasks([{ id: "t", prompt: "p", expect: ["("] }])).toThrow(/bad pattern/);
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
  expect(s.tokenRatio.n).toBe(3);
  expect(s.tokenRatio.max).toBeLessThan(1);
});
