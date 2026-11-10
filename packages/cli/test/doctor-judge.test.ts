import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFakeJudge } from "@accreta/judges/testing";
import { run } from "../src/main.ts";

const SECRET = "sk-test-doctor-0123456789";
const ENV_KEYS = [
  "ACCRETA_ROOT",
  "ACCRETA_INDEX_PATH",
  "ACCRETA_JUDGE_KEY",
  "ACCRETA_JUDGE_URL",
  "ACCRETA_JUDGE_ROUTE",
] as const;
const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

let base = "";
let repo = "";
let output: string[] = [];

async function doctor(): Promise<number> {
  output = [];
  return run(["doctor"], { cwd: repo, out: (line) => output.push(line), err: () => {} });
}

const text = () => output.join("\n");
const judgeSection = () => {
  const all = text();
  const start = all.indexOf("\njudge\n");
  return all.slice(start, all.indexOf("\nskill\n", start));
};
const configure = (block: string) => appendFileSync(join(repo, "accreta.config.yaml"), block);

beforeEach(async () => {
  base = mkdtempSync(join(tmpdir(), "accreta-doctor-judge-"));
  repo = join(base, "repo");
  mkdirSync(join(repo, ".git"), { recursive: true });
  for (const key of ENV_KEYS) delete process.env[key];
  await run(["init"], { cwd: repo, out: () => {}, err: () => {} });
  rmSync(join(repo, "sources", "example.yaml"), { force: true });
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  rmSync(base, { recursive: true, force: true });
});

describe("accreta doctor: the judge", () => {
  test("without a judge block there is no judge section and no request", async () => {
    const server = await startFakeJudge();
    process.env.ACCRETA_JUDGE_URL = server.url;
    await doctor();
    expect(text()).not.toContain("\njudge");
    expect(server.requests).toHaveLength(0);
    await server.close();
  });

  test("a reachable judge: variable named, set, one probe with latency and model", async () => {
    const server = await startFakeJudge({ model: "fake-jev-9" });
    configure("judge:\n  route: local\n");
    process.env.ACCRETA_JUDGE_URL = server.url;
    process.env.ACCRETA_JUDGE_KEY = SECRET;
    expect(await doctor()).toBe(0);
    expect(text()).toMatch(/ACCRETA_JUDGE_KEY is set/);
    expect(text()).toMatch(/ok: local answered in \d+ ms, model fake-jev-9/);
    expect(text()).not.toContain(SECRET);
    expect(server.requests).toHaveLength(1);
    await server.close();
  });

  test("an unset variable is named, not valued", async () => {
    configure("judge:\n  route: typesafe\n");
    expect(await doctor()).toBe(1);
    expect(text()).toContain("ACCRETA_JUDGE_KEY is not set");
  });

  test("a key written in a knowledge-base page fails doctor without printing it", async () => {
    const server = await startFakeJudge();
    configure("judge:\n  route: local\n");
    process.env.ACCRETA_JUDGE_URL = server.url;
    process.env.ACCRETA_JUDGE_KEY = SECRET;
    mkdirSync(join(repo, "knowledge"), { recursive: true });
    writeFileSync(join(repo, "knowledge", "oops.md"), `# Notes\n\nkey: ${SECRET}\n`);
    expect(await doctor()).toBe(1);
    expect(text()).toContain("knowledge/oops.md");
    expect(text()).not.toContain(SECRET);
    expect(server.requests).toHaveLength(0);
    await server.close();
  });

  test("a key written in accreta.config.yaml fails doctor without printing it", async () => {
    configure(`judge:\n  route: local\n  api_key: ${SECRET}\n`);
    process.env.ACCRETA_JUDGE_KEY = SECRET;
    expect(await doctor()).toBe(1);
    expect(text()).toContain("looks like a credential");
    expect(text()).toContain("accreta.config.yaml");
    expect(text()).not.toContain(SECRET);
  });

  test("a key pasted as the variable name is not printed", async () => {
    configure("judge:\n  route: local\n  api_key_env: sk-live-PASTED-0123456789\n");
    expect(await doctor()).toBe(1);
    expect(text()).not.toContain("sk-live-PASTED");
    process.env.ACCRETA_JUDGE_API_KEY_ENV = "sk-live-PASTED-0123456789";
    try {
      expect(await doctor()).toBe(1);
      expect(text()).not.toContain("sk-live-PASTED");
    } finally {
      delete process.env.ACCRETA_JUDGE_API_KEY_ENV;
    }
  });

  test("a file url next to an env url is a note, not a failure", async () => {
    const server = await startFakeJudge();
    configure("judge:\n  route: local\n  url: http://127.0.0.1:1\n");
    process.env.ACCRETA_JUDGE_URL = server.url;
    expect(await doctor()).toBe(0);
    expect(judgeSection()).toContain("ACCRETA_JUDGE_URL wins");
    await server.close();
  });

  test("a url in the config file fails doctor", async () => {
    configure("judge:\n  route: local\n  url: http://127.0.0.1:1\n");
    expect(await doctor()).toBe(1);
    expect(text()).toContain("ACCRETA_JUDGE_URL");
  });

  test("an unreachable judge is one warning and exit 0", async () => {
    const server = await startFakeJudge();
    const url = server.url;
    await server.close();
    configure("judge:\n  route: local\n");
    process.env.ACCRETA_JUDGE_URL = url;
    expect(await doctor()).toBe(0);
    expect(judgeSection().match(/^ {2}unreachable:/gm)).toHaveLength(1);
  });
});
