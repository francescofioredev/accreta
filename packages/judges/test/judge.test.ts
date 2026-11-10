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
      config: () => "judge:\n  route: local\n",
      env: (url: string) => ({ ACCRETA_JUDGE_URL: url }),
    },
    {
      name: "cloudflare",
      opts: { envelope: ["result", "result"] },
      config: () => `judge:\n  route: cloudflare\n  api_key_env: ACCRETA_JUDGE_KEY\n`,
      env: (url: string) => ({ ACCRETA_JUDGE_URL: `${url}/accounts/x/ai/run/{model}` }),
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
        parseConfig(c.config()),
        { ACCRETA_JUDGE_KEY: "fake", ...c.env(server.url) },
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
      parseConfig("judge:\n  route: local\n  model: m-1\n"),
      { ACCRETA_JUDGE_URL: body.url },
      fast,
    )!.probe!();
    expect(body.requests[0]?.body.model).toBe("m-1");
    await createJudge(
      parseConfig(`judge:\n  route: cloudflare\n  model: acme/jev\n`),
      { ACCRETA_JUDGE_KEY: "k", ACCRETA_JUDGE_URL: `${url.url}/run/{model}` },
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
      parseConfig(`judge:\n  route: typesafe\n`),
      { ACCRETA_JUDGE_KEY: "k1", ACCRETA_JUDGE_URL: server.url },
      fast,
    );
    await judge!.probe!();
    expect(server.requests[0]?.body.model).toBe("jev-latest");
    expect(server.requests[0]?.headers.authorization).toBe("Bearer k1");
  });

  test("a url in the file is refused on every route, and nothing is sent", async () => {
    const server = await fake();
    for (const route of ["typesafe", "cloudflare", "local"]) {
      expect(() =>
        createJudge(parseConfig(`judge:\n  route: ${route}\n  url: ${server.url}\n`), {
          ACCRETA_JUDGE_KEY: "k1",
        }),
      ).toThrow("ACCRETA_JUDGE_URL");
    }
    expect(server.requests).toHaveLength(0);
  });

  test("the env url wins over a url in the file", async () => {
    const server = await fake();
    const other = await fake();
    await createJudge(
      parseConfig(`judge:\n  route: local\n  url: ${other.url}\n`),
      { ACCRETA_JUDGE_KEY: "k1", ACCRETA_JUDGE_URL: server.url },
      fast,
    )!.probe!();
    expect(server.requests[0]?.headers.authorization).toBe("Bearer k1");
    expect(other.requests).toHaveLength(0);
  });

  test("api_key_env must be an ACCRETA_JUDGE_ variable", () => {
    const config = parseConfig("judge:\n  route: local\n  api_key_env: GITHUB_TOKEN\n");
    expect(() => createJudge(config, { GITHUB_TOKEN: "ghp_x" })).toThrow(
      "starting with ACCRETA_JUDGE_",
    );
    expect(() => createJudge(config, { GITHUB_TOKEN: "ghp_x" })).not.toThrow("ghp_x");
  });

  test("a cloudflare url without {model} is refused", () => {
    const config = parseConfig("judge:\n  route: cloudflare\n");
    expect(() =>
      createJudge(config, { ACCRETA_JUDGE_KEY: "k", ACCRETA_JUDGE_URL: "http://x/run" }),
    ).toThrow("{model}");
  });

  test("is read from the variable api_key_env names and sent as a bearer", async () => {
    const server = await fake();
    const judge = createJudge(
      parseConfig(`judge:\n  route: local\n  api_key_env: ACCRETA_JUDGE_MY_VAR\n`),
      {
        ACCRETA_JUDGE_MY_VAR: "secret-from-env",
        ACCRETA_JUDGE_KEY: "other",
        ACCRETA_JUDGE_URL: server.url,
      },
      fast,
    );
    await judge!.probe!();
    expect(server.requests[0]?.headers.authorization).toBe("Bearer secret-from-env");
  });

  test("a local route without a key sends none", async () => {
    const server = await fake();
    await createJudge(
      parseConfig("judge:\n  route: local\n"),
      { ACCRETA_JUDGE_URL: server.url },
      fast,
    )!.probe!();
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
      parseConfig(`judge:\n  route: local\n`),
      { ACCRETA_JUDGE_KEY: "sk-do-not-print", ACCRETA_JUDGE_URL: server.url },
      fast,
    );
    const error = await judge!.probe!().catch((e: unknown) => e);
    expect(server.requests[0]?.headers.authorization).toBe("Bearer sk-do-not-print");
    expect(error).toBeInstanceOf(JudgeUnavailableError);
    expect(String((error as Error).message)).not.toContain("sk-do-not-print");
    expect(server.requests).toHaveLength(1);
  });
});

describe("failures", () => {
  test("a 503 is retried and then answers", async () => {
    const server = await fake({ failWith: [503, 429] });
    const judge = createJudge(
      parseConfig("judge:\n  route: local\n"),
      { ACCRETA_JUDGE_URL: server.url },
      fast,
    );
    expect((await judge!.probe!()).model).toBe("fake-jev-1");
    expect(server.requests).toHaveLength(3);
  });

  test("retries run out", async () => {
    const server = await fake({ failWith: [503, 503, 503] });
    const judge = createJudge(
      parseConfig("judge:\n  route: local\n"),
      { ACCRETA_JUDGE_URL: server.url },
      fast,
    );
    await expect(judge!.probe!()).rejects.toThrow("HTTP 503");
  });

  test("a 400 is not retried", async () => {
    const server = await fake({ failWith: [400] });
    const judge = createJudge(
      parseConfig("judge:\n  route: local\n"),
      { ACCRETA_JUDGE_URL: server.url },
      fast,
    );
    await expect(judge!.probe!()).rejects.toBeInstanceOf(JudgeUnavailableError);
    expect(server.requests).toHaveLength(1);
  });

  test("nothing listening is JudgeUnavailableError", async () => {
    const server = await fake();
    const url = server.url;
    await server.close();
    const judge = createJudge(
      parseConfig("judge:\n  route: local\n"),
      { ACCRETA_JUDGE_URL: url },
      fast,
    );
    await expect(judge!.rank("q", candidates)).rejects.toBeInstanceOf(JudgeUnavailableError);
  });

  test("a reply without every probability is refused, not guessed", async () => {
    const server = await fake({
      rawReply: { model: "m", answers: { verdict: { probabilities: { supports: 0.9 } } } },
    });
    const judge = createJudge(
      parseConfig("judge:\n  route: local\n"),
      { ACCRETA_JUDGE_URL: server.url },
      fast,
    );
    await expect(judge!.supports("c", "t")).rejects.toThrow("not in the expected shape");
  });
});

describe("what the judge sees", () => {
  test("supports sends the claim and the cited text and nothing else", async () => {
    const server = await fake();
    const judge = createJudge(
      parseConfig("judge:\n  route: local\n"),
      { ACCRETA_JUDGE_URL: server.url },
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
      parseConfig("judge:\n  route: local\n"),
      { ACCRETA_JUDGE_URL: server.url },
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
    ).toThrow("ACCRETA_JUDGE_URL");
  });
  test("an env route override cannot send the key to a file url", async () => {
    const server = await fake();
    const config = parseConfig(`judge:\n  route: local\n  url: ${server.url}\n`);
    expect(() =>
      createJudge(config, { ACCRETA_JUDGE_ROUTE: "typesafe", ACCRETA_JUDGE_KEY: "k" }),
    ).toThrow("ACCRETA_JUDGE_URL");
    expect(server.requests).toHaveLength(0);
  });
  test("a blank ACCRETA_JUDGE_URL does not count as an override", () => {
    const config = parseConfig("judge:\n  route: typesafe\n  url: http://x\n");
    expect(() => createJudge(config, { ACCRETA_JUDGE_KEY: "k", ACCRETA_JUDGE_URL: "  " })).toThrow(
      "ACCRETA_JUDGE_URL",
    );
  });
  test("an env override can change the route", () => {
    expect(() =>
      createJudge(parseConfig("judge:\n  route: local\n  url: http://x\n"), {
        ACCRETA_JUDGE_ROUTE: "nope",
      }),
    ).toThrow("not a route");
  });
});
