import { expect, test } from "bun:test";
import { claims } from "../lib/claims.ts";

const BODY = `# Routing

The router matches paths in registration order.[^a] It stops at the first match.

- A trailing slash is significant for static routes.[^b]
- See [[middleware]].

\`\`\`python
# This is code. It has sentences. None of them count.
\`\`\`

| Method | Meaning of the column |
|---|---|

> Quoted source text is evidence, not a claim of the page.

<!-- A comment with enough words to count if it were prose. -->

Handlers may return a tuple of body, status and headers.[^a][^c]

[^a]: flask @ abc1234 · src/flask/app.py#L10-L20
[^b]: flask @ abc1234 · src/flask/routing.py#L5
[^c]: flask @ abc1234 · src/flask/app.py#L30
`;

test("counts sentences of prose and list items, not code, headings, tables, quotes or definitions", () => {
  const found = claims(BODY);
  expect(found.map((c) => c.text)).toEqual([
    "The router matches paths in registration order.",
    "It stops at the first match.",
    "A trailing slash is significant for static routes.",
    "Handlers may return a tuple of body, status and headers.",
  ]);
  expect(found.map((c) => c.footnotes)).toEqual([["a"], [], ["b"], ["a", "c"]]);
});

test("a sentence under five words is not a claim", () => {
  expect(claims("It is fast. The cache keeps every compiled template in memory.")).toHaveLength(1);
});
