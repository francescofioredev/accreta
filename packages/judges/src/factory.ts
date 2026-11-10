import {
  JudgeConfigError,
  resolveJudgeSettings,
  type AccretaConfig,
  type Judge,
} from "@accreta/core";
import { TypeSafeJudge, type Retry } from "./client.ts";
import { ROUTES, ROUTE_NAMES } from "./presets.ts";

export interface JudgeOptions {
  fetch?: typeof fetch;
  retry?: Retry;
  timeoutMs?: number;
}

/**
 * The judge `judge:` describes, or null when there is no such block.
 * Throws `JudgeConfigError` when there is a block that cannot make one; the message names the
 * environment variable that is missing, never a value.
 */
export function createJudge(
  config: Pick<AccretaConfig, "judge">,
  env: Readonly<Record<string, string | undefined>> = process.env,
  options: JudgeOptions = {},
): Judge | null {
  const settings = resolveJudgeSettings(config.judge, env);
  if (settings === null) return null;
  if (settings.problems.length > 0) throw new JudgeConfigError(settings.problems.join("; "));

  const name = settings.route as string;
  const route = Object.hasOwn(ROUTES, name) ? ROUTES[name] : undefined;
  if (!route) {
    throw new JudgeConfigError(
      `judge.route "${name}" is not a route. Known: ${ROUTE_NAMES.join(", ")}`,
    );
  }
  // A url in a cloned knowledge base must not receive the key: only the environment may move it.
  const fileUrl = settings.url !== undefined && !settings.urlFromEnv;
  if (fileUrl && route.keyRequired) {
    throw new JudgeConfigError(
      `judge.url in the config file is not read on the ${name} route, which sends a key; set ACCRETA_JUDGE_URL`,
    );
  }
  const url = fileUrl ? settings.url : (settings.url ?? route.url);
  if (!url) {
    throw new JudgeConfigError(
      route.keyRequired
        ? `ACCRETA_JUDGE_URL is required for the ${name} route`
        : `judge.url is required for the ${name} route`,
    );
  }

  if (route.modelIn === "url" && !url.includes("{model}")) {
    throw new JudgeConfigError(`judge.url for the ${name} route must contain {model}`);
  }
  const apiKey = fileUrl ? undefined : env[settings.apiKeyEnv]?.trim() || undefined;
  if (route.keyRequired && !apiKey) {
    throw new JudgeConfigError(`${settings.apiKeyEnv} is not set; the ${name} route needs a key`);
  }
  return new TypeSafeJudge({
    judge: name,
    route,
    url,
    model: settings.model,
    apiKey,
    ...options,
  });
}
