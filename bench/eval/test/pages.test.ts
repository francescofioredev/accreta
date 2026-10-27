import { expect, test } from "bun:test";
import { join } from "node:path";
import { kbAt } from "../lib/accreta.ts";
import { measurePages } from "../lib/pages.ts";
import { commit, declareGit, kbDir, lines, page, repo, write } from "./fixture.ts";

test("four footnotes from #123, one on an undeclared source, and an uncited claim", () => {
  const root = kbDir();
  const pin = repo(join(root, "sources", "app"), { "src/app.py": lines(20) });
  declareGit(root, "app", "sources/app");
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
      `[^ok]: app @ ${pin} · src/app.py#L2-L4`,
      `[^path]: app @ ${pin} · src/config.py#L1-L3`,
      `[^range]: app @ ${pin} · src/app.py#L18-L40`,
      `[^rev]: app @ deadbee · src/app.py#L5-L6`,
      `[^other]: lib @ ${pin} · README.md#L1-L2`,
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

test("a footnote citing an abbreviated revision fails, not resolves", () => {
  const root = kbDir();
  const pin = repo(join(root, "sources", "app"), { "src/app.py": lines(20) });
  declareGit(root, "app", "sources/app");
  page(root, "short", {
    source: "app",
    verified: pin,
    canonical: "app:src/app.py#L1-L3",
    body: `The router matches paths in registration order.[^a]\n\n[^a]: app @ ${pin.slice(0, 7)} · src/app.py#L1-L3`,
  });
  const [a] = measurePages(kbAt(root)).citations.footnotes;
  expect(a).toMatchObject({ status: "fails", why: ["citation-revision-abbreviated"] });
});

test("a clean knowledge base resolves every footnote and lints clean", () => {
  const root = kbDir();
  const pin = repo(join(root, "sources", "app"), { "src/app.py": lines(20) });
  declareGit(root, "app", "sources/app");
  page(root, "clean", {
    source: "app",
    verified: pin,
    canonical: "app:src/app.py#L1-L3",
    body: `The router matches paths in registration order.[^a]\n\n[^a]: app @ ${pin} · src/app.py#L1-L3`,
  });
  const m = measurePages(kbAt(root), pin);
  expect(m.citations.resolve).toMatchObject({ k: 1, n: 1 });
  expect(m.citations.gate).toBe("not shown");
  expect(m.lint.pagesClean).toMatchObject({ k: 1, n: 1 });

  // H1 is read at the pin: a source already moved on is refused, not measured.
  write(join(root, "sources", "app"), "src/app.py", lines(21));
  commit(join(root, "sources", "app"), "move on");
  expect(() => measurePages(kbAt(root), pin)).toThrow(/check it out first/);
});
