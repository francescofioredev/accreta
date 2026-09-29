const tokens = (s: string) => s.split(/(\s+)/).filter((t) => t.length);

export interface Hunk {
  before: string;
  removed: string;
  added: string;
  after: string;
}

/** Word-level diff as hunks with `pad` words of context either side. Whitespace-only changes are dropped. */
export function wordHunks(a: string, b: string, pad = 6): Hunk[] {
  const x = tokens(a).filter((t) => /\S/.test(t));
  const y = tokens(b).filter((t) => /\S/.test(t));
  const dp = Array.from({ length: x.length + 1 }, () => new Uint32Array(y.length + 1));
  for (let i = x.length - 1; i >= 0; i--)
    for (let j = y.length - 1; j >= 0; j--)
      dp[i]![j] = x[i] === y[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
  const ops: { op: "=" | "-" | "+"; w: string }[] = [];
  let i = 0;
  let j = 0;
  while (i < x.length || j < y.length) {
    if (i < x.length && j < y.length && x[i] === y[j]) (ops.push({ op: "=", w: x[i++]! }), j++);
    else if (j < y.length && (i === x.length || dp[i]![j + 1]! >= dp[i + 1]![j]!))
      ops.push({ op: "+", w: y[j++]! });
    else ops.push({ op: "-", w: x[i++]! });
  }
  const hunks: Hunk[] = [];
  let k = 0;
  while (k < ops.length) {
    if (ops[k]!.op === "=") {
      k++;
      continue;
    }
    let end = k;
    // Merge changes separated by fewer than 2*pad unchanged words into one hunk.
    for (let m = k; m < ops.length; m++) {
      if (ops[m]!.op !== "=") end = m;
      else if (m - end > 2 * pad) break;
    }
    const span = ops.slice(k, end + 1);
    const words = (op: string, xs: typeof ops) =>
      xs
        .filter((o) => o.op === op || o.op === "=")
        .map((o) => o.w)
        .join(" ");
    hunks.push({
      before: ops
        .slice(Math.max(0, k - pad), k)
        .map((o) => o.w)
        .join(" "),
      removed: words("-", span),
      added: words("+", span),
      after: ops
        .slice(end + 1, end + 1 + pad)
        .filter((o) => o.op === "=")
        .map((o) => o.w)
        .join(" "),
    });
    k = end + 1;
  }
  return hunks;
}
