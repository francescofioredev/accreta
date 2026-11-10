import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFakeJudge, type FakeJudgeOptions } from "@accreta/judges/testing";
import { run } from "../src/main.ts";

const ENV_KEYS = ["ACCRETA_ROOT", "ACCRETA_INDEX_PATH", "ACCRETA_JUDGE_URL", "ACCRETA_JUDGE_KEY"];
const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

let base = "";
let repo = "";
let output: string[] = [];
let errors: string[] = [];

async function cli(...args: string[]): Promise<number> {
  output = [];
  errors = [];
  return run(args, { cwd: repo, out: (l) => output.push(l), err: (l) => errors.push(l) });
}
const json = () => JSON.parse(output.join("\n"));
const paths = () => json().results.map((r: { path: string }) => r.path);

/** The probability each page title gets from the fake judge, read from the request. */
const byTitle =
  (table: Record<string, number>): FakeJudgeOptions["noul"] =>
  (name, _question, request) => {
    const state = request.body.state as { candidates: { id: string; title: string }[] };
    return table[state.candidates.find((c) => c.id === name)?.title ?? ""] ?? 0;
  };

beforeEach(async () => {
  base = mkdtempSync(join(tmpdir(), "accreta-rerank-"));
  repo = join(base, "repo");
  mkdirSync(join(repo, ".git"), { recursive: true });
  for (const key of ENV_KEYS) delete process.env[key];
  await cli("init");
  for (const [file, title] of [
    ["a.md", "Alpha"],
    ["b.md", "Bravo"],
    ["c.md", "Charlie"],
  ] as const) {
    mkdirSync(join(repo, "knowledge"), { recursive: true });
    writeFileSync(
      join(repo, "knowledge", file),
      `---\ntype: note\n---\n\n# ${title}\n\nThe ${title} page discusses tropopause flux.\n`,
    );
  }
  await cli("reindex");
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  rmSync(base, { recursive: true, force: true });
});

const configure = (extra = "") =>
  appendFileSync(join(repo, "accreta.config.yaml"), `judge:\n  route: local\n${extra}`);

describe("accreta search --rerank", () => {
  test("reorders by the judge's probability and names judge, model, probability", async () => {
    const fake = await startFakeJudge({
      model: "fake-jev-7",
      noul: byTitle({ Alpha: 0.2, Bravo: 0.9, Charlie: 0.5 }),
    });
    configure();
    process.env.ACCRETA_JUDGE_URL = fake.url;
    expect(await cli("search", "tropopause", "--rerank", "--json")).toBe(0);
    const results = json().results;
    expect(results.map((r: { title: string }) => r.title)).toEqual(["Bravo", "Charlie", "Alpha"]);
    expect(results[0]).toMatchObject({ judge: "local", model: "fake-jev-7", probability: 0.9 });
    expect(fake.requests).toHaveLength(1);
    const state = fake.requests[0]!.body.state as {
      query: string;
      candidates: { title: string; summary: string }[];
    };
    expect(state.query).toBe("tropopause");
    expect(state.candidates.map((c) => c.title).toSorted()).toEqual(["Alpha", "Bravo", "Charlie"]);
    expect(state.candidates[0]!.summary).toContain("tropopause flux");
    await fake.close();
  });

  test("a hit below --limit can be promoted into it", async () => {
    const fake = await startFakeJudge({ noul: byTitle({ Alpha: 0, Bravo: 0, Charlie: 1 }) });
    configure();
    process.env.ACCRETA_JUDGE_URL = fake.url;
    await cli("search", "tropopause", "--limit", "1", "--json");
    const plain = paths();
    await cli("search", "tropopause", "--limit", "1", "--rerank", "--json");
    expect(json().count).toBe(1);
    expect(json().results[0].title).toBe("Charlie");
    expect(plain).not.toEqual(paths());
    await fake.close();
  });

  test("text output shows the probability", async () => {
    const fake = await startFakeJudge({ noul: byTitle({ Alpha: 0.25 }) });
    configure();
    process.env.ACCRETA_JUDGE_URL = fake.url;
    await cli("search", "tropopause", "--rerank");
    expect(output.join("\n")).toMatch(/judged p=0\.25 by local /);
    await fake.close();
  });

  test("without --rerank a configured judge is never called and the output is unchanged", async () => {
    await cli("search", "tropopause", "--json");
    const unconfigured = output.join("\n");
    const fake = await startFakeJudge();
    configure();
    process.env.ACCRETA_JUDGE_URL = fake.url;
    await cli("search", "tropopause", "--json");
    expect(output.join("\n")).toBe(unconfigured);
    expect(fake.requests).toHaveLength(0);
    await fake.close();
  });

  test("with no judge block it says so, exits 0 and keeps the search order", async () => {
    await cli("search", "tropopause", "--json");
    const plain = paths();
    expect(await cli("search", "tropopause", "--rerank", "--json")).toBe(0);
    expect(paths()).toEqual(plain);
    expect(json().rerank_note).toMatch(/No judge is configured/);
    expect(errors.join("\n")).toMatch(/No judge is configured/);
  });

  test("an unreachable judge degrades with one warning and the search order", async () => {
    await cli("search", "tropopause", "--json");
    const plain = paths();
    const fake = await startFakeJudge({ failWith: [500, 500, 500, 500] });
    configure();
    process.env.ACCRETA_JUDGE_URL = fake.url;
    expect(await cli("search", "tropopause", "--rerank", "--json")).toBe(0);
    expect(paths()).toEqual(plain);
    expect(json().rerank_note).toMatch(/could not rerank/);
    expect(errors).toHaveLength(1);
    await fake.close();
  });

  test("a judge block that cannot make a judge degrades the same way, never printing a key", async () => {
    configure();
    process.env.ACCRETA_JUDGE_KEY = "sk-test-rerank-0123456789";
    expect(await cli("search", "tropopause", "--rerank", "--json")).toBe(0);
    expect(json().rerank_note).toMatch(/ACCRETA_JUDGE_URL is required/);
    expect(output.join("\n") + errors.join("\n")).not.toContain("sk-test-rerank-0123456789");
  });

  test("only search takes --rerank", async () => {
    expect(await cli("lint", "--rerank")).toBe(2);
    expect(errors.join("\n")).toContain("--rerank");
  });
});
