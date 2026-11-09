import { afterEach, describe, expect, test } from "bun:test";
import { JudgeConfigError, JudgeUnavailableError, parseConfig } from "@accreta/core";
import { createJudge } from "../src/index.ts";
import { startFakeJudge, type FakeJudge } from "../src/testing.ts";

const fast = { retry: { attempts: 3, baseMs: 0 } };
const open: FakeJudge[] = [];
async function fake(...args: Parameters<typeof startFakeJudge>) {
  const f = await startFakeJudge(...args);
  open.push(f);
  return f;
}
afterEach(async () => {
  await Promise.all(open.splice(0).map((f) => f.close()));
});

const candidates = [
  { id: "knowledge/a.md", title: "Albedo", summary: "Reflectivity of ice." },
  { id: "knowledge/b.md", title: "Lapse rate", summary: "Temperature falls with height." },
];

describe("no judge configured", () => {
  test("a config without a judge block makes no judge", () => {
    expect(createJudge(parseConfig("page_types: [note]"), {})).toBeNull();
  });
});

describe("the same config on two routes", () => {
  const cases = [
    {
      name: "local",
      opts: {},
      config: (url: string) => `judge:\n  route: local\n  url: ${url}\n`,
    },
    {
      name: "cloudflare",
      opts: { envelope: ["result", "result"] },
      config: (url: string) =>
        `judge:\n  route: cloudflare\n  url: ${url}/accounts/x/ai/run/{model}\n  api_key_env: ACCRETA_JUDGE_KEY\n`,
    },
  ];
  for (const c of cases) {
    test(`${c.name}: rank and supports answer in the same shape`, async () => {
      const server = await fake({
        ...c.opts,
        noul: (name) => (name === "c2" ? 0.9 : 0.1),
        choice: () => ({ supports: 0.8, contradicts: 0.1, says_nothing: 0.1 }),
      });
      const judge = createJudge(
        parseConfig(c.config(server.url)),
        { ACCRETA_JUDGE_KEY: "fake" },
        fast,
      );
      const ranked = await judge!.rank("what falls with height", candidates);
      expect(ranked.map((r) => [r.id, r.probability])).toEqual([
        ["knowledge/a.md", 0.1],
        ["knowledge/b.md", 0.9],
      ]);
      expect(ranked[0]).toMatchObject({ model: "fake-jev-1" });
      const verdict = await judge!.supports("Ice reflects light", "Ice is highly reflective.");
      expect(verdict).toMatchObject({ verdict: "supports", probability: 0.8, model: "fake-jev-1" });
      expect(verdict.judge).toBe(c.name);
    });
  }

  test("the model goes where the route says", async () => {
    const body = await fake();
    const url = await fake({ envelope: ["result", "result"] });
    await createJudge(
      parseConfig(`judge:\n  route: local\n  url: ${body.url}\n  model: m-1\n`),
      {},
      fast,
    )!.probe!();
    expect(body.requests[0]?.body.model).toBe("m-1");
    await createJudge(
      parseConfig(
        `judge:\n  route: cloudflare\n  url: ${url.url}/run/{model}\n  model: acme/jev\n`,
      ),
      { ACCRETA_JUDGE_KEY: "k" },
      fast,
    )!.probe!();
    expect(url.requests[0]?.path).toBe("/run/acme/jev");
    expect(url.requests[0]?.body.model).toBeUndefined();
  });
});

describe("the key", () => {
  test("the typesafe route sends its model in the body and a bearer", async () => {
    const server = await fake();
    const judge = createJudge(
      parseConfig(`judge:\n  route: typesafe\n  url: ${server.url}\n`),
      { ACCRETA_JUDGE_KEY: "k1" },
      fast,
    );
    await judge!.probe!();
    expect(server.requests[0]?.body.model).toBe("jev-latest");
    expect(server.requests[0]?.headers.authorization).toBe("Bearer k1");
  });

  test("api_key_env must be an ACCRETA_ variable", () => {
    const config = parseConfig(
      "judge:\n  route: local\n  url: http://x\n  api_key_env: GITHUB_TOKEN\n",
    );
    expect(() => createJudge(config, { GITHUB_TOKEN: "ghp_x" })).toThrow("starting with ACCRETA_");
    expect(() => createJudge(config, { GITHUB_TOKEN: "ghp_x" })).not.toThrow("ghp_x");
  });

  test("a cloudflare url without {model} is refused", () => {
    const config = parseConfig("judge:\n  route: cloudflare\n  url: http://x/run\n");
    expect(() => createJudge(config, { ACCRETA_JUDGE_KEY: "k" })).toThrow("{model}");
  });

  test("is read from the variable api_key_env names and sent as a bearer", async () => {
    const server = await fake();
    const judge = createJudge(
      parseConfig(
        `judge:\n  route: local\n  url: ${server.url}\n  api_key_env: ACCRETA_MY_JUDGE_VAR\n`,
      ),
      { ACCRETA_MY_JUDGE_VAR: "secret-from-env", ACCRETA_JUDGE_KEY: "other" },
      fast,
    );
    await judge!.probe!();
    expect(server.requests[0]?.headers.authorization).toBe("Bearer secret-from-env");
  });

  test("a local route without a key sends none", async () => {
    const server = await fake();
    await createJudge(parseConfig(`judge:\n  route: local\n  url: ${server.url}\n`), {}, fast)!
      .probe!();
    expect(server.requests[0]?.headers.authorization).toBeUndefined();
  });

  test("a route that needs one names the variable, not a value", () => {
    const config = parseConfig("judge:\n  route: typesafe\n");
    const env = { ACCRETA_JUDGE_KEY: "" };
    expect(() => createJudge(config, env)).toThrow(JudgeConfigError);
    expect(() => createJudge(config, env)).toThrow("ACCRETA_JUDGE_KEY is not set");
  });

  test("a refused key does not echo it", async () => {
    const server = await fake({ failWith: [401] });
    const judge = createJudge(
      parseConfig(`judge:\n  route: local\n  url: ${server.url}\n`),
      { ACCRETA_JUDGE_KEY: "sk-do-not-print" },
      fast,
    );
    const error = await judge!.probe!().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(JudgeUnavailableError);
    expect(String((error as Error).message)).not.toContain("sk-do-not-print");
    expect(server.requests).toHaveLength(1);
  });
});

describe("failures", () => {
  test("a 503 is retried and then answers", async () => {
    const server = await fake({ failWith: [503, 429] });
    const judge = createJudge(
      parseConfig(`judge:\n  route: local\n  url: ${server.url}\n`),
      {},
      fast,
    );
    expect((await judge!.probe!()).model).toBe("fake-jev-1");
    expect(server.requests).toHaveLength(3);
  });

  test("retries run out", async () => {
    const server = await fake({ failWith: [503, 503, 503] });
    const judge = createJudge(
      parseConfig(`judge:\n  route: local\n  url: ${server.url}\n`),
      {},
      fast,
    );
    await expect(judge!.probe!()).rejects.toThrow("HTTP 503");
  });

  test("a 400 is not retried", async () => {
    const server = await fake({ failWith: [400] });
    const judge = createJudge(
      parseConfig(`judge:\n  route: local\n  url: ${server.url}\n`),
      {},
      fast,
    );
    await expect(judge!.probe!()).rejects.toBeInstanceOf(JudgeUnavailableError);
    expect(server.requests).toHaveLength(1);
  });

  test("nothing listening is JudgeUnavailableError", async () => {
    const server = await fake();
    const url = server.url;
    await server.close();
    const judge = createJudge(parseConfig(`judge:\n  route: local\n  url: ${url}\n`), {}, fast);
    await expect(judge!.rank("q", candidates)).rejects.toBeInstanceOf(JudgeUnavailableError);
  });

  test("a reply without every probability is refused, not guessed", async () => {
    const server = await fake({
      rawReply: { model: "m", answers: { verdict: { probabilities: { supports: 0.9 } } } },
    });
    const judge = createJudge(
      parseConfig(`judge:\n  route: local\n  url: ${server.url}\n`),
      {},
      fast,
    );
    await expect(judge!.supports("c", "t")).rejects.toThrow("not in the expected shape");
  });
});

describe("what the judge sees", () => {
  test("supports sends the claim and the cited text and nothing else", async () => {
    const server = await fake();
    const judge = createJudge(
      parseConfig(`judge:\n  route: local\n  url: ${server.url}\n`),
      {},
      fast,
    );
    await judge!.supports("the claim", "the cited lines");
    expect(server.requests[0]?.body.state).toEqual({
      claim: "the claim",
      cited_text: "the cited lines",
    });
  });

  test("rank names candidates by position, not by the page's own id", async () => {
    const server = await fake();
    const judge = createJudge(
      parseConfig(`judge:\n  route: local\n  url: ${server.url}\n`),
      {},
      fast,
    );
    await judge!.rank("q", candidates);
    const body = JSON.stringify(server.requests[0]?.body);
    expect(body).not.toContain("knowledge/a.md");
    expect(Object.keys(server.requests[0]!.body.questions)).toEqual(["c1", "c2"]);
  });
});

describe("bad config", () => {
  test("an unknown route lists the known ones", () => {
    expect(() => createJudge(parseConfig("judge:\n  route: nope\n"), {})).toThrow("Known: ");
  });
  test("cloudflare needs a url", () => {
    expect(() =>
      createJudge(parseConfig("judge:\n  route: cloudflare\n"), { ACCRETA_JUDGE_KEY: "k" }),
    ).toThrow("judge.url is required");
  });
  test("an env override can change the route", () => {
    expect(() =>
      createJudge(parseConfig("judge:\n  route: local\n  url: http://x\n"), {
        ACCRETA_JUDGE_ROUTE: "nope",
      }),
    ).toThrow("not a route");
  });
});
