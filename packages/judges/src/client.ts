import {
  JudgeUnavailableError,
  SUPPORT_VERDICTS,
  type Judge,
  type JudgeCandidate,
  type JudgeProbe,
  type RankedCandidate,
  type SupportResult,
  type SupportVerdict,
} from "@accreta/core";
import type { Route } from "./presets.ts";

export interface Retry {
  attempts: number;
  /** Doubles on each retry. */
  baseMs: number;
}

export interface ClientOptions {
  /** Names the route in every result. */
  judge: string;
  route: Route;
  url: string;
  model?: string;
  /** Read by the caller from the variable `judge.api_key_env` names. */
  apiKey?: string;
  fetch?: typeof fetch;
  retry?: Retry;
  timeoutMs?: number;
}

const DEFAULT_RETRY: Retry = { attempts: 3, baseMs: 500 };
const DEFAULT_TIMEOUT_MS = 30_000;
const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504]);

type Question =
  | { type: "noul"; instructions: string }
  | { type: "choice"; instructions: string; criteria: Record<string, string> };

const SUPPORT_QUESTION: Question = {
  type: "choice",
  instructions: "What does the cited text say about the claim?",
  criteria: {
    supports: "the cited text states or directly implies the claim",
    contradicts: "the cited text states or directly implies that the claim is false",
    says_nothing: "the cited text does not settle whether the claim is true",
  },
};

const unit = (x: unknown): number | undefined =>
  typeof x === "number" && x >= 0 && x <= 1 ? x : undefined;

const isObject = (x: unknown): x is Record<string, unknown> =>
  typeof x === "object" && x !== null && !Array.isArray(x);

interface Reply {
  answers: Record<string, unknown>;
  model: string | undefined;
}

export class TypeSafeJudge implements Judge {
  readonly #o: ClientOptions;

  constructor(options: ClientOptions) {
    this.#o = options;
  }

  async rank(query: string, candidates: readonly JudgeCandidate[]): Promise<RankedCandidate[]> {
    if (candidates.length === 0) return [];
    // The wire ids are positional: a candidate's own id could be any text a page chose.
    const wire = candidates.map((c, i) => ({
      id: `c${i + 1}`,
      title: c.title,
      summary: c.summary,
    }));
    const questions: Record<string, Question> = {};
    for (const c of wire) {
      questions[c.id] = {
        type: "noul",
        instructions: `Is candidate ${c.id} the page the query asks for?`,
      };
    }
    const reply = await this.#ask({ query, candidates: wire }, questions);
    const served = this.#served(reply);
    return candidates.map((candidate, i) => {
      const answer = reply.answers[`c${i + 1}`];
      const probability = isObject(answer) ? unit(answer.noul) : undefined;
      if (probability === undefined) throw this.#malformed(`no probability for candidate ${i + 1}`);
      return { id: candidate.id, probability, judge: this.#o.judge, model: served };
    });
  }

  async supports(claim: string, citedText: string): Promise<SupportResult> {
    const reply = await this.#ask({ claim, cited_text: citedText }, { verdict: SUPPORT_QUESTION });
    const answer = reply.answers.verdict;
    const raw = isObject(answer) && isObject(answer.probabilities) ? answer.probabilities : {};
    const probabilities = {} as Record<SupportVerdict, number>;
    for (const verdict of SUPPORT_VERDICTS) {
      const p = unit(raw[verdict]);
      if (p === undefined) throw this.#malformed(`no probability for "${verdict}"`);
      probabilities[verdict] = p;
    }
    let verdict: SupportVerdict = "says_nothing";
    for (const v of SUPPORT_VERDICTS) if (probabilities[v] > probabilities[verdict]) verdict = v;
    return {
      verdict,
      probability: probabilities[verdict],
      probabilities,
      judge: this.#o.judge,
      model: this.#served(reply),
    };
  }

  async probe(): Promise<JudgeProbe> {
    const started = performance.now();
    const reply = await this.#ask("accreta probe", {
      probe: { type: "noul", instructions: "Is this text a sentence?" },
    });
    const answer = reply.answers.probe;
    if (!isObject(answer) || unit(answer.noul) === undefined) throw this.#malformed("no answer");
    return {
      judge: this.#o.judge,
      model: this.#served(reply),
      latencyMs: Math.round(performance.now() - started),
    };
  }

  #served(reply: Reply): string {
    return reply.model ?? this.#o.model ?? this.#o.route.model ?? "unspecified";
  }

  #malformed(what: string): JudgeUnavailableError {
    return new JudgeUnavailableError(
      `${this.#o.judge} answered, but not in the expected shape: ${what}`,
    );
  }

  async #ask(state: unknown, questions: Record<string, Question>): Promise<Reply> {
    const { route, apiKey } = this.#o;
    const retry = this.#o.retry ?? DEFAULT_RETRY;
    const doFetch = this.#o.fetch ?? fetch;
    const model = this.#o.model ?? route.model;
    const url = this.#o.url.replaceAll("{model}", model ?? "");
    const body =
      route.modelIn === "body" && model !== undefined
        ? { model, state, questions }
        : { state, questions };
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (route.authHeader && apiKey) headers[route.authHeader] = `${route.authPrefix}${apiKey}`;

    let failure = "";
    for (let attempt = 0; attempt < retry.attempts; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, retry.baseMs * 2 ** (attempt - 1)));
      let response: Response;
      try {
        response = await doFetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(this.#o.timeoutMs ?? DEFAULT_TIMEOUT_MS),
        });
      } catch (error) {
        failure = `${this.#o.judge} is unreachable: ${error instanceof Error ? error.message : String(error)}`;
        continue;
      }
      if (RETRYABLE.has(response.status)) {
        failure = `${this.#o.judge} answered HTTP ${response.status}`;
        continue;
      }
      if (response.status === 401 || response.status === 403) {
        throw new JudgeUnavailableError(
          `${this.#o.judge} refused the key (HTTP ${response.status})`,
        );
      }
      if (!response.ok) {
        throw new JudgeUnavailableError(`${this.#o.judge} answered HTTP ${response.status}`);
      }
      return this.#unwrap(await response.json().catch(() => undefined));
    }
    throw new JudgeUnavailableError(failure);
  }

  #unwrap(json: unknown): Reply {
    let inner: unknown = json;
    for (const key of this.#o.route.envelope) inner = isObject(inner) ? inner[key] : undefined;
    if (!isObject(inner) || !isObject(inner.answers)) throw this.#malformed("no answers");
    return {
      answers: inner.answers,
      model: typeof inner.model === "string" && inner.model ? inner.model : undefined,
    };
  }
}
