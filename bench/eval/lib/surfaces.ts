import { totalTokens, type Session } from "./agent.ts";
import {
  interval,
  mcnemarPaired,
  summary,
  type Interval,
  type McNemar,
  type Summary,
} from "./stats.ts";

export interface Task {
  id: string;
  prompt: string;
  /** Patterns the final answer must all match, case-insensitive: success is mechanical. */
  expect: string[];
  /** Patterns it must not match: a wrong answer that happens to name the right thing. */
  reject?: string[];
}

/** Pre-registered in protocol.md. */
export const TASKS_REQUIRED = 20;
export const MIN_DISCORDANT = 6;

export function validateTasks(raw: unknown): Task[] {
  if (!Array.isArray(raw)) throw new Error("tasks: expected an array");
  const problems: string[] = [];
  const seen = new Set<string>();
  raw.forEach((t: Partial<Task>, i) => {
    const at = `task ${i + 1}${t?.id ? ` (${t.id})` : ""}`;
    if (!t?.id || !t.prompt) problems.push(`${at}: needs an id and a prompt`);
    if (!Array.isArray(t?.expect) || t.expect.length === 0) problems.push(`${at}: no expect`);
    if (t?.reject !== undefined && !Array.isArray(t.reject))
      problems.push(`${at}: reject is a list`);
    for (const p of [...(t?.expect ?? []), ...(t?.reject ?? [])]) {
      try {
        new RegExp(p, "i");
      } catch {
        problems.push(`${at}: bad pattern ${p}`);
      }
    }
    if (t?.id && seen.has(t.id)) problems.push(`${at}: duplicate id`);
    if (t?.id) seen.add(t.id);
  });
  if (problems.length > 0) throw new Error(`tasks:\n  ${problems.join("\n  ")}`);
  return raw as Task[];
}

export const succeeded = (task: Task, s: Session) =>
  !s.is_error &&
  task.expect.every((p) => new RegExp(p, "i").test(s.result)) &&
  !(task.reject ?? []).some((p) => new RegExp(p, "i").test(s.result));

export interface SurfaceScore {
  success: Interval;
  tokens: Summary;
  turns: Summary;
}

export interface SurfacesScore {
  arms: Record<string, SurfaceScore>;
  /** `b`: only the first arm succeeded; `c`: only the second. Two-sided: no direction is pre-registered. */
  mcnemar: McNemar;
  /** Second arm's tokens over the first's: all tasks' totals, and the geometric mean per task. */
  tokenRatio: { ofTotals: number; geometricMean: number; perTask: Summary };
  /** Under MIN_DISCORDANT discordant tasks no exact test can reject, so success is described only. */
  inference: "tested" | "descriptive only";
}

export function scoreSurfaces(
  tasks: readonly Task[],
  sessions: readonly Session[],
  [a, b]: [string, string],
): SurfacesScore {
  const of = (arm: string) =>
    new Map(sessions.filter((s) => s.arm === arm).map((s) => [s.item, s]));
  const runs = { [a]: of(a), [b]: of(b) };
  const arms: Record<string, SurfaceScore> = {};
  for (const arm of [a, b]) {
    const done = tasks.flatMap((t) =>
      runs[arm]!.has(t.id) ? [[t, runs[arm]!.get(t.id)!] as const] : [],
    );
    arms[arm] = {
      success: interval(done.filter(([t, s]) => succeeded(t, s)).length, done.length),
      tokens: summary(done.map(([, s]) => totalTokens(s.usage))),
      turns: summary(done.map(([, s]) => s.num_turns)),
    };
  }
  const paired = tasks.filter((t) => runs[a]!.has(t.id) && runs[b]!.has(t.id));
  const ok = (arm: string) => paired.map((t) => succeeded(t, runs[arm]!.get(t.id)!));
  const used = (arm: string) => paired.map((t) => totalTokens(runs[arm]!.get(t.id)!.usage));
  const [x, y] = [used(a), used(b)];
  const ratios = x.flatMap((v, i) => (v > 0 && y[i]! > 0 ? [y[i]! / v] : []));
  const sum = (v: number[]) => v.reduce((p, q) => p + q, 0);
  const mcnemar = mcnemarPaired(ok(a), ok(b));
  return {
    arms,
    mcnemar,
    tokenRatio: {
      ofTotals: sum(x) > 0 ? sum(y) / sum(x) : NaN,
      geometricMean: ratios.length ? Math.exp(sum(ratios.map(Math.log)) / ratios.length) : NaN,
      perTask: summary(ratios),
    },
    inference: mcnemar.b + mcnemar.c < MIN_DISCORDANT ? "descriptive only" : "tested",
  };
}
