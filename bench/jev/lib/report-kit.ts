import { readFileSync, writeFileSync } from "node:fs";

export const table = (head: string[], rows: (string | number)[][]) =>
  [
    `| ${head.join(" | ")} |`,
    `| ${head.map(() => "---").join(" | ")} |`,
    ...rows.map((r) => `| ${r.join(" | ")} |`),
  ].join("\n");

/** Replace the text between `<!-- report:NAME -->` and `<!-- /report:NAME -->` in a doc. */
export function splice(file: string, name: string, body: string): boolean {
  const doc = readFileSync(file, "utf8");
  const re = new RegExp(`(<!-- report:${name} -->)[\\s\\S]*?(<!-- /report:${name} -->)`);
  if (!re.test(doc)) throw new Error(`${file}: no report:${name} markers`);
  const next = doc.replace(re, `$1\n\n${body.trim()}\n\n$2`);
  if (next !== doc) writeFileSync(file, next);
  return next !== doc;
}

/** A small line chart as standalone SVG; `series` are [x, y] points in [0, 1]. */
export function lineChart(opts: {
  title: string;
  xLabel: string;
  yLabel: string;
  series: { name: string; points: [number, number][]; color: string }[];
  marks?: { name: string; x: number; y: number; color: string }[];
}): string {
  const W = 640,
    H = 420,
    L = 60,
    R = 170,
    T = 40,
    B = 50;
  const x = (v: number) => L + v * (W - L - R);
  const y = (v: number) => H - B - v * (H - T - B);
  const grid = [0, 0.25, 0.5, 0.75, 1]
    .map(
      (g) =>
        `<line x1="${x(0)}" x2="${x(1)}" y1="${y(g)}" y2="${y(g)}" class="grid"/><text x="${L - 8}" y="${y(g) + 4}" text-anchor="end">${g * 100}%</text><text x="${x(g)}" y="${H - B + 18}" text-anchor="middle">${g * 100}%</text>`,
    )
    .join("");
  const lines = opts.series
    .map(
      (s, i) =>
        `<polyline fill="none" stroke="${s.color}" stroke-width="2" points="${s.points.map(([a, b]) => `${x(a).toFixed(1)},${y(b).toFixed(1)}`).join(" ")}"/><line x1="${W - R + 16}" x2="${W - R + 36}" y1="${T + 10 + i * 20}" y2="${T + 10 + i * 20}" stroke="${s.color}" stroke-width="2"/><text x="${W - R + 42}" y="${T + 14 + i * 20}">${s.name}</text>`,
    )
    .join("");
  const marks = (opts.marks ?? [])
    .map(
      (m, i) =>
        `<circle cx="${x(m.x)}" cy="${y(m.y)}" r="5" fill="${m.color}"/><circle cx="${W - R + 26}" cy="${T + 10 + (opts.series.length + i) * 20}" r="5" fill="${m.color}"/><text x="${W - R + 42}" y="${T + 14 + (opts.series.length + i) * 20}">${m.name}</text>`,
    )
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" font-family="system-ui, sans-serif" font-size="12">
<style>text{fill:#333}.grid{stroke:#ddd}@media (prefers-color-scheme:dark){text{fill:#ddd}.grid{stroke:#444}}</style>
<text x="${L}" y="22" font-size="14" font-weight="600">${opts.title}</text>
${grid}
<text x="${(x(0) + x(1)) / 2}" y="${H - 12}" text-anchor="middle">${opts.xLabel}</text>
<text transform="translate(16 ${(y(0) + y(1)) / 2}) rotate(-90)" text-anchor="middle">${opts.yLabel}</text>
${lines}${marks}
</svg>
`;
}
