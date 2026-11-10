/**
 * A route is data: where to post, how to authenticate, where the model name goes and where
 * the answers sit in the reply. Adding one is an entry here and a test, not code.
 */
export interface Route {
  /** The URL; `{model}` is replaced. Absent when the user must give the whole URL. */
  url?: string;
  /** The model to ask for when `judge.model` is not set. */
  model?: string;
  /** Where the requested model goes: a `model` field in the body, or the `{model}` in the URL. */
  modelIn: "body" | "url";
  /** The header carrying the key. Absent: no key is sent. */
  authHeader?: string;
  /** Written before the key in that header: `Bearer `. */
  authPrefix: string;
  /** Without a key the route cannot work; otherwise a key is sent only when one is set. */
  keyRequired: boolean;
  /** Keys leading from the reply to the object holding `answers`; empty when it is the reply. */
  envelope: readonly string[];
}

export const ROUTES: Readonly<Record<string, Route>> = {
  // https://docs.typesafe.ai/api.md: POST /v1/systemone with a Bearer key, `model` in the body.
  typesafe: {
    url: "https://api.typesafe.ai/v1/systemone",
    model: "jev-latest",
    modelIn: "body",
    authHeader: "Authorization",
    authPrefix: "Bearer ",
    keyRequired: true,
    envelope: [],
  },
  // The account id is part of the URL, so `judge.url` is required. The envelope is the one the
  // study read through the Workers AI binding (bench/jev/lib/jev.ts); the REST reply is not yet
  // checked against a live key.
  cloudflare: {
    model: "typesafe/jev",
    modelIn: "url",
    authHeader: "Authorization",
    authPrefix: "Bearer ",
    keyRequired: true,
    envelope: ["result", "result"],
  },
  // Any server that takes the same `{state, questions}` and answers `{model, answers}`.
  local: {
    modelIn: "body",
    authHeader: "Authorization",
    authPrefix: "Bearer ",
    keyRequired: false,
    envelope: [],
  },
};

export const ROUTE_NAMES = Object.keys(ROUTES);
