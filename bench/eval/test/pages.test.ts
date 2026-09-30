import { expect, test } from "bun:test";
import { join } from "node:path";
import { kbAt } from "../lib/accreta.ts";
import { measurePages } from "../lib/pages.ts";
import { declareGit, kbDir, lines, page, repo } from "./fixture.ts";

test("four footnotes from #123, one on an undeclared source, and an uncited claim", () => {
  const root = kbDir();
  const pin = repo(join(root, "sources", "app"), { "src/app.py": lines(20) });
  declareGit(root, "app", "sources/app");
  const at = pin.slice(0, 7);
  page(root, "routing", {
    source: "app",
    verified: pin,
    canonical: "app:src/app.py#L1-L3",
    body: [
      "The router matches paths in registration order.[^ok]",
      "",
      "The router also reads a configuration file at startup.[^path]",
      "",
      "Handlers are wrapped in a middleware chain before dispatch.[^range]",
      "",
      "The application object is created lazily on first request.[^rev]",
      "",
      "A second library documents the same behaviour elsewhere.[^other]",
      "",
      "Nothing on this line carries any citation at all.",
      "",
      `[^ok]: app @ ${at} · src/app.py#L2-L4`,
      `[^path]: app @ ${at} · src/config.py#L1-L3`,
      `[^range]: app @ ${at} · src/app.py#L18-L40`,
      `[^rev]: app @ deadbee · src/app.py#L5-L6`,
      `[^other]: lib @ ${at} · README.md#L1-L2`,
    ].join("\n"),
  });

  const m = measurePages(kbAt(root));
  expect(m.pages).toBe(1);
  expect(m.claims.cited).toMatchObject({ k: 5, n: 6 });

  const why = Object.fromEntries(m.citations.footnotes.map((f) => [f.footnote, f]));
  expect(why.ok).toMatchObject({ status: "resolves" });
  expect(why.path).toMatchObject({ status: "fails", why: ["citation-path-missing"] });
  expect(why.range).toMatchObject({ status: "fails", why: ["citation-locator-missing"] });
  expect(why.rev).toMatchObject({ status: "fails", why: ["citation-revision-unknown"] });
  expect(why.other).toMatchObject({ status: "unchecked" });

  expect(m.citations.byStatus).toEqual({ resolves: 1, fails: 3, unchecked: 1 });
  expect(m.citations.resolve).toMatchObject({ k: 1, n: 5 });
  expect(m.citations.resolveChecked).toMatchObject({ k: 1, n: 4 });
  expect(m.citations.gate).toBe("failed");
  expect(m.lint.perPage.max).toBe(3);
  expect(m.lint.byKind["citation-path-missing"]).toBe(1);
});

test("a clean knowledge base resolves every footnote and lints clean", () => {
  const root = kbDir();
  const pin = repo(join(root, "sources", "app"), { "src/app.py": lines(20) });
  declareGit(root, "app", "sources/app");
  page(root, "clean", {
    source: "app",
    verified: pin,
    canonical: "app:src/app.py#L1-L3",
    body: `The router matches paths in registration order.[^a]\n\n[^a]: app @ ${pin.slice(0, 7)} · src/app.py#L1-L3`,
  });
  const m = measurePages(kbAt(root));
  expect(m.citations.resolve).toMatchObject({ k: 1, n: 1 });
  expect(m.citations.gate).toBe("not shown");
  expect(m.lint.pagesClean).toMatchObject({ k: 1, n: 1 });
});
