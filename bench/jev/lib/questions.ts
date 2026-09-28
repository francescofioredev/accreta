export type Question =
  | { type: "noul"; instructions: string }
  | { type: "choice"; instructions: string; criteria: Record<string, string> }
  | { type: "score"; instructions: string; criteria: string[] };

export type Questions = Record<string, Question>;

/** One answer, normalised across providers: `p` is P(yes) for a noul, the distribution for a choice. */
export interface Answer {
  type: Question["type"];
  p?: number;
  choice?: string;
  probabilities?: Record<string, number>;
  score?: number;
  confidence?: number;
}

export interface Decision {
  provider: "jev" | "claude";
  served_by: string;
  answers: Record<string, Answer>;
  latency_ms: number;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  error?: string;
  cached?: boolean;
}
