import { JUDGE_DEFAULTS, JudgeUnavailableError, type Judge, type JudgeIdentity } from "../judge.ts";

/** The study's summary: the body without its first heading, whitespace collapsed, cut here. */
export const SUMMARY_CHARS = 600;

export function summaryOf(body: string): string {
  return body
    .replace(/^#.*\n/, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, SUMMARY_CHARS);
}

export interface RerankOptions<T> {
  /** How many of the leading hits the judge sees; default `JUDGE_DEFAULTS.rerankTop`. */
  top?: number;
  /** The text offered beside the title. */
  summary: (hit: T) => string;
}

export type Reranked<T> = T & Partial<JudgeIdentity & { probability: number }>;

/**
 * The first `top` hits reordered by the judge's P(this is the page the query asks for), highest
 * first and stable on ties, followed by the rest in their own order. Only judged hits carry
 * judge, model and probability. Throws `JudgeUnavailableError`; the caller keeps the order it had.
 */
export async function rerank<T extends { path: string; title: string }>(
  hits: readonly T[],
  query: string,
  judge: Judge,
  options: RerankOptions<T>,
): Promise<Reranked<T>[]> {
  const top = Math.max(1, Math.floor(options.top ?? JUDGE_DEFAULTS.rerankTop));
  const head = hits.slice(0, top);
  if (head.length === 0) return [...hits];
  const ranked = await judge.rank(
    query,
    head.map((hit) => ({ id: hit.path, title: hit.title, summary: options.summary(hit) })),
  );
  const judged = head.map((hit, i): [Reranked<T>, number] => {
    const answer = ranked[i];
    if (!answer || answer.id !== hit.path) {
      throw new JudgeUnavailableError(
        "the judge answered for different candidates than it was given",
      );
    }
    return [
      { ...hit, judge: answer.judge, model: answer.model, probability: answer.probability },
      i,
    ];
  });
  judged.sort((a, b) => (b[0].probability ?? 0) - (a[0].probability ?? 0) || a[1] - b[1]);
  return [...judged.map(([hit]) => hit), ...hits.slice(top)];
}
