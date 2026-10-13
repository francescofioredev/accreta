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
}

export function validateTasks(raw: unknown): Task[] {
  if (!Array.isArray(raw)) throw new Error("tasks: expected an array");
  const problems: string[] = [];
  const seen = new Set<string>();
  raw.forEach((t: Partial<Task>, i) => {
    const at = `task ${i + 1}${t?.id ? ` (${t.id})` : ""}`;
    if (!t?.id || !t.prompt) problems.push(`${at}: needs an id and a prompt`);
    if (!Array.isArray(t?.expect) || t.expect.length === 0) problems.push(`${at}: no expect`);
    for (const p of t?.expect ?? []) {
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
  !s.is_error && task.expect.every((p) => new RegExp(p, "i").test(s.result));

export interface SurfaceScore {
  success: Interval;
  tokens: Summary;
  turns: Summary;
}

export interface SurfacesScore {
  arms: Record<string, SurfaceScore>;
  /** `b`: only the first arm succeeded; `c`: only the second. Two-sided: no direction is pre-registered. */
  mcnemar: McNemar;
  /** Per task, second arm's total tokens over the first's. */
  tokenRatio: Summary;
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
  const ratios = paired.flatMap((t) => {
    const [x, y] = [totalTokens(runs[a]!.get(t.id)!.usage), totalTokens(runs[b]!.get(t.id)!.usage)];
    return x > 0 ? [y / x] : [];
  });
  return { arms, mcnemar: mcnemarPaired(ok(a), ok(b)), tokenRatio: summary(ratios) };
}
