import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A fake judge server for tests: it binds port 0, records what it was sent and needs no key.
 * Shared so every package's tests exercise the same wire.
 */

export interface FakeQuestion {
  type: "noul" | "choice";
  instructions: string;
  criteria?: Record<string, string>;
}

export interface FakeRequest {
  path: string;
  headers: IncomingHttpHeaders;
  body: { model?: string; state: unknown; questions: Record<string, FakeQuestion> };
}

export interface FakeJudgeOptions {
  /** Wrap the reply as a route does: `["result", "result"]` for the cloudflare shape. */
  envelope?: readonly string[];
  /** The model the server reports having used. */
  model?: string;
  /** P(yes) for one noul; default 0.5. */
  noul?: (name: string, question: FakeQuestion, request: FakeRequest) => number;
  /** The distribution for one choice; default uniform over the criteria. */
  choice?: (name: string, question: FakeQuestion, request: FakeRequest) => Record<string, number>;
  /** Statuses to answer with, one per request, before answering for real. */
  failWith?: number[];
  /** Answer with this body (as JSON) instead of the computed one, for a malformed reply. */
  rawReply?: unknown;
}

export interface FakeJudge {
  /** `http://127.0.0.1:<port>`; append a path if the test wants one. */
  url: string;
  requests: FakeRequest[];
  close(): Promise<void>;
}

export async function startFakeJudge(options: FakeJudgeOptions = {}): Promise<FakeJudge> {
  const requests: FakeRequest[] = [];
  const failures = [...(options.failWith ?? [])];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const respond = (status: number, json: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(json));
      };
      let body: FakeRequest["body"];
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        return respond(400, { detail: "not json" });
      }
      const request: FakeRequest = { path: req.url ?? "/", headers: req.headers, body };
      requests.push(request);
      const status = failures.shift();
      if (status !== undefined) return respond(status, { detail: "fake failure" });

      const answers: Record<string, unknown> = {};
      for (const [name, question] of Object.entries(body.questions)) {
        if (question.type === "noul") {
          answers[name] = { type: "noul", noul: options.noul?.(name, question, request) ?? 0.5 };
        } else {
          const keys = Object.keys(question.criteria ?? {});
          const probabilities =
            options.choice?.(name, question, request) ??
            Object.fromEntries(keys.map((k) => [k, 1 / keys.length]));
          const best = Object.entries(probabilities).toSorted((a, b) => b[1] - a[1])[0];
          answers[name] = {
            type: "choice",
            choice: best?.[0],
            confidence: best?.[1],
            probabilities,
          };
        }
      }
      let reply: unknown = options.rawReply ?? {
        model: options.model ?? "fake-jev-1",
        answers,
        usage: { input_tokens: 1, output_tokens: 1 },
      };
      if (options.rawReply === undefined) {
        for (const key of (options.envelope ?? []).toReversed()) reply = { [key]: reply };
      }
      respond(200, reply);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
