import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/main.ts";
import { COMMAND_ARGS } from "../src/commands/shared.ts";
import type { CommandContext } from "../src/commands.ts";
import type { DriftReport } from "@accreta/core";
import { GITHUB_BODY_LIMIT, toGithub } from "../src/commands/drift.ts";

let root = "";
let output: string[] = [];
let errors: string[] = [];

function ctx(): CommandContext {
  return {
    cwd: root,
    out: (line) => output.push(line),
    err: (line) => errors.push(line),
  };
}

const stdout = () => output.join("\n");
const stderr = () => errors.join("\n");

function writePage(relativePath: string, contents: string): void {
  const full = join(root, "knowledge", relativePath);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, contents, "utf-8");
}

async function cli(...argv: string[]): Promise<number> {
  return run(argv, ctx());
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "accreta-cli-"));
  output = [];
  errors = [];
  // Commands resolve the index from the workspace; keep it inside the temp root.
  delete process.env.ACCRETA_INDEX_PATH;
  delete process.env.ACCRETA_ROOT;
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("accreta init", () => {
  test("creates the config, the knowledge base and the sources directory", async () => {
    expect(await cli("init")).toBe(0);
    expect(existsSync(join(root, "accreta.config.yaml"))).toBe(true);
    expect(existsSync(join(root, "knowledge"))).toBe(true);
    expect(existsSync(join(root, "sources"))).toBe(true);
  });

  test("writes a constitution alongside the configuration", async () => {
    await cli("init");
    expect(existsSync(join(root, "AGENTS.md"))).toBe(true);
    expect(readFileSync(join(root, "AGENTS.md"), "utf-8")).toContain(
      "Every non-trivial claim carries a citation",
    );
  });

  test("a preset selects both the vocabulary and the constitution", async () => {
    expect(await cli("init", "--preset", "research")).toBe(0);
    expect(readFileSync(join(root, "accreta.config.yaml"), "utf-8")).toContain("contradiction");
    expect(readFileSync(join(root, "AGENTS.md"), "utf-8")).toContain("Preset: research literature");
  });

  test("an unknown preset is refused before anything is written", async () => {
    expect(await cli("init", "--preset", "nonsense")).toBe(1);
    expect(stderr()).toContain("Unknown preset");
    expect(existsSync(join(root, "accreta.config.yaml"))).toBe(false);
  });

  test("an existing agent file is never overwritten", async () => {
    // Somebody's AGENTS.md is somebody's work.
    writeFileSync(join(root, "AGENTS.md"), "my own instructions", "utf-8");
    await cli("init");
    expect(readFileSync(join(root, "AGENTS.md"), "utf-8")).toBe("my own instructions");
    expect(stderr()).toContain("Not overwriting");
  });

  test("refuses to overwrite an existing configuration", async () => {
    await cli("init");
    expect(await cli("init")).toBe(1);
    expect(stderr()).toContain("already exists");
  });
});

describe("accreta reindex", () => {
  test("reports how much it indexed", async () => {
    await cli("init");
    writePage("a.md", "---\ntype: note\n---\n\n# A\n\nSee [[b]].\n");
    writePage("b.md", "---\ntype: note\n---\n\n# B\n");

    expect(await cli("reindex")).toBe(0);
    expect(stdout()).toContain("Indexed 2 pages");
  });

  test("mentions unresolvable links, because a rebuild is when someone is looking", async () => {
    await cli("init");
    writePage("a.md", "---\ntype: note\n---\n\n# A\n\nSee [[../../../etc/passwd]].\n");

    await cli("reindex");
    expect(stdout()).toContain("did not resolve");
  });

  test("without a configuration it says what to do", async () => {
    await expect(cli("reindex")).rejects.toThrow(/accreta init/);
  });
});

describe("accreta search", () => {
  beforeEach(async () => {
    await cli("init");
    writePage("a.md", "---\ntype: note\n---\n\n# Radiative forcing\n\ntropopause flux\n");
    await cli("reindex");
    output = [];
  });

  test("finds a page by a body term", async () => {
    expect(await cli("search", "tropopause")).toBe(0);
    expect(stdout()).toContain("knowledge/a.md");
  });

  test("reports no matches plainly", async () => {
    await cli("search", "nonexistentterm");
    expect(stdout()).toContain("No matches");
  });

  test("without a query it prints usage", async () => {
    expect(await cli("search")).toBe(2);
    expect(stderr()).toContain("Usage");
  });

  test("--limit and --source narrow the plain output too", async () => {
    writePage("b.md", "---\ntype: note\nsource: other\n---\n\n# B\n\ntropopause again\n");
    await cli("reindex");
    output = [];

    await cli("search", "tropopause", "--limit", "1");
    expect(stdout()).toContain("1 result(s)");
    output = [];
    await cli("search", "tropopause", "--source", "other");
    expect(stdout()).toContain("knowledge/b.md");
    expect(stdout()).not.toContain("knowledge/a.md");
  });

  test("a --limit the MCP tool would refuse is refused here", async () => {
    expect(await cli("search", "tropopause", "--limit", "51")).toBe(2);
    expect(stderr()).toContain("--limit");
  });
});

describe("accreta show", () => {
  beforeEach(async () => {
    await cli("init");
    writePage("concepts/x.md", "---\ntype: concept\n---\n\n# Concept X\n\nBody text.\n");
    await cli("reindex");
    output = [];
  });

  test("accepts a wikilink target as well as a path", async () => {
    expect(await cli("show", "concepts/x")).toBe(0);
    expect(stdout()).toContain("Concept X");
    expect(stdout()).toContain("Body text.");
  });

  test("a missing page is an error, not empty output", async () => {
    expect(await cli("show", "concepts/nothing")).toBe(1);
    expect(stderr()).toContain("No page matches");
  });
});

describe("accreta consumers", () => {
  beforeEach(async () => {
    await cli("init");
    writePage("a.md", "---\ntype: note\nrelated: [[b]]\n---\n\n# A\n");
    writePage("b.md", "---\ntype: note\n---\n\n# B\n\nMentions [[a]].\n");
    await cli("reindex");
    output = [];
  });

  test("shows declared relations", async () => {
    await cli("consumers", "b");
    expect(stdout()).toContain("knowledge/a.md");
  });

  test("inline mentions need --inline, and the default says so", async () => {
    await cli("consumers", "a");
    const withoutInline = stdout();
    output = [];
    await cli("consumers", "a", "--inline");
    expect(stdout()).toContain("wikilink");
    expect(withoutInline).not.toContain("wikilink");
  });
});

describe("accreta lint", () => {
  test("exits non-zero when something is wrong, so CI can fail on it", async () => {
    await cli("init");
    writePage("a.md", "---\ntype: note\nrelated: [[missing]]\n---\n\n# A\n");
    await cli("reindex");
    output = [];

    expect(await cli("lint")).toBe(1);
    expect(stdout()).toContain("dangling-link");
  });

  test("exits zero on a clean knowledge base", async () => {
    await cli("init");
    writePage(
      "a.md",
      '---\ntype: note\ncanonical_source: "s:x.md#L1"\nlast_verified_revision: abc\n---\n\n# A\n',
    );
    await cli("reindex");
    output = [];

    expect(await cli("lint")).toBe(0);
    expect(stdout()).toContain("nothing to report");
  });
});

describe("accreta drift", () => {
  test("a revision the source cannot place is reported, not called current", async () => {
    await cli("init");
    mkdirSync(join(root, "sources", "docs"), { recursive: true });
    writeFileSync(join(root, "sources", "docs", "a.md"), "text", "utf-8");
    rmSync(join(root, "sources", "example.yaml"), { force: true });
    writeFileSync(
      join(root, "sources", "docs.yaml"),
      'id: docs\ntype: fs\nroot: sources/docs\nextensions: [".md"]\n',
      "utf-8",
    );
    writePage(
      "a.md",
      "---\ntype: note\nsource: docs\nlast_verified_revision: fromapreviousrun\n---\n\n# A\n",
    );
    await cli("reindex");
    output = [];

    expect(await cli("drift")).toBe(1);
    expect(stdout()).toContain("cannot place");
  });

  test("a delegated source produces a work order and does not fail the run", async () => {
    await cli("init");
    rmSync(join(root, "sources", "example.yaml"), { force: true });
    writeFileSync(
      join(root, "sources", "design-docs.yaml"),
      "id: design-docs\ntype: delegated\nvia: notion\nscope: |\n  The Design decisions page.\n",
      "utf-8",
    );
    writePage(
      "a.md",
      "---\ntype: note\nsource: design-docs\nlast_verified_revision: 2026-08-01T10:22:00Z\n---\n\n# A\n",
    );
    await cli("reindex");
    output = [];

    // Exit 0: nothing is known to be wrong. What is true is that accreta did
    // not look, and the report says who has to.
    expect(await cli("drift")).toBe(0);
    expect(stdout()).toContain("read through notion by the agent");
    expect(stdout()).toContain("1 page(s) for the agent to re-verify");
    expect(stdout()).toContain("knowledge/a.md (verified at 2026-08-01T10:22:00Z)");
    expect(stdout()).toContain("The Design decisions page.");
    // Never the outcome that means "the revision is gone, start over".
    expect(stdout()).not.toContain("cannot place");
  });

  test("--strict fails on work nobody has done rather than on work that went wrong", async () => {
    await cli("init");
    rmSync(join(root, "sources", "example.yaml"), { force: true });
    writeFileSync(
      join(root, "sources", "design-docs.yaml"),
      "id: design-docs\ntype: delegated\nvia: notion\nscope: The Design decisions page.\n",
      "utf-8",
    );
    writePage(
      "a.md",
      "---\ntype: note\nsource: design-docs\nlast_verified_revision: 2026-08-01T10:22:00Z\n---\n\n# A\n",
    );
    await cli("reindex");
    output = [];

    expect(await cli("drift")).toBe(0);
    expect(await cli("drift", "--strict")).toBe(1);
  });

  test("a delegated source declared without a scope names the file to fix", async () => {
    await cli("init");
    rmSync(join(root, "sources", "example.yaml"), { force: true });
    writeFileSync(
      join(root, "sources", "design-docs.yaml"),
      "id: design-docs\ntype: delegated\nvia: notion\n",
      "utf-8",
    );
    await cli("reindex");
    output = [];

    expect(await cli("drift")).toBe(1);
    expect(stdout()).toContain("sources/design-docs.yaml — did not load");
    expect(stdout()).toContain("declares no `scope`");
  });

  test("with no sources declared it says so rather than failing", async () => {
    await cli("init");
    rmSync(join(root, "sources", "example.yaml"), { force: true });
    writePage("a.md", "---\ntype: note\n---\n\n# A\n");
    await cli("reindex");
    output = [];

    expect(await cli("drift")).toBe(0);
    expect(stdout()).toContain("No sources declared");
  });

  // The report groups by revision, so the headline number has to be summed over
  // the groups. Taking it from `stale.length` would still print a plausible
  // count — of revisions, silently relabelled as pages.
  //
  // Driven through a git source because `fs` keeps its revision snapshots in
  // memory: across two CLI invocations it can only answer "cannot place", which
  // is the documented consequence in ADR-0002 and not the path under test here.
  test("stale pages are counted and listed individually, not per revision", async () => {
    await cli("init");
    rmSync(join(root, "sources", "example.yaml"), { force: true });

    const docs = join(root, "sources", "docs");
    mkdirSync(docs, { recursive: true });
    const git = async (...args: string[]) => {
      const proc = Bun.spawn(["git", ...args], { cwd: docs, stdout: "pipe", stderr: "pipe" });
      if ((await proc.exited) !== 0) throw new Error(await new Response(proc.stderr).text());
    };
    writeFileSync(join(docs, "a.md"), "text", "utf-8");
    await git("init", "-q");
    await git("config", "user.email", "t@example.invalid");
    await git("config", "user.name", "Test");
    await git("add", ".");
    await git("commit", "-qm", "first");
    const head = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: docs });
    const revision = head.stdout.toString().trim();

    writeFileSync(
      join(root, "sources", "docs.yaml"),
      "id: docs\ntype: git\nroot: sources/docs\n",
      "utf-8",
    );
    for (const name of ["one", "two", "three"]) {
      writePage(
        `${name}.md`,
        `---\ntype: note\nsource: docs\nlast_verified_revision: ${revision}\n---\n\n# ${name}\n`,
      );
    }
    await cli("reindex");

    writeFileSync(join(docs, "a.md"), "rewritten", "utf-8");
    await git("commit", "-qam", "second");
    output = [];

    expect(await cli("drift")).toBe(1);
    // Three pages, one revision: the count must be the pages.
    expect(stdout()).toContain("3 page(s) may have drifted");
    for (const name of ["one", "two", "three"]) {
      expect(stdout()).toContain(`knowledge/${name}.md`);
    }
  });
});

const twentyLines = (edit: Record<number, string> = {}) =>
  Array.from({ length: 20 }, (_, i) => edit[i + 1] ?? `line ${i + 1}`).join("\n") + "\n";

describe("accreta drift at line granularity", () => {
  test("pages are ordered and explained by what happened to their cited lines", async () => {
    await cli("init");
    rmSync(join(root, "sources", "example.yaml"), { force: true });

    const docs = join(root, "sources", "docs");
    mkdirSync(docs, { recursive: true });
    const git = async (...args: string[]) => {
      const proc = Bun.spawn(["git", ...args], { cwd: docs, stdout: "pipe", stderr: "pipe" });
      if ((await proc.exited) !== 0) throw new Error(await new Response(proc.stderr).text());
    };
    writeFileSync(join(docs, "a.md"), twentyLines(), "utf-8");
    writeFileSync(join(docs, "b.md"), "untouched\n", "utf-8");
    await git("init", "-q");
    await git("config", "user.email", "t@example.invalid");
    await git("config", "user.name", "Test");
    await git("add", ".");
    await git("commit", "-qm", "first");
    const revision = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: docs })
      .stdout.toString()
      .trim();

    writeFileSync(
      join(root, "sources", "docs.yaml"),
      "id: docs\ntype: git\nroot: sources/docs\n",
      "utf-8",
    );
    const page = (name: string, citation: string) =>
      writePage(
        `${name}.md`,
        `---\ntype: note\nsource: docs\nlast_verified_revision: ${revision}\n---\n\n# ${name}\n\n` +
          `A claim.[^c]\n\n[^c]: docs @ ${revision.slice(0, 7)} · ${citation}\n`,
      );
    page("changed", "a.md#L3-L5");
    page("still", "a.md#L10-L12");
    page("elsewhere", "b.md#L1");
    await cli("reindex");

    writeFileSync(join(docs, "a.md"), twentyLines({ 4: "rewritten" }), "utf-8");
    await git("commit", "-qam", "second");
    output = [];

    expect(await cli("drift")).toBe(1);
    const out = stdout();
    expect(out).toContain("3 page(s) may have drifted");
    expect(out).toContain("knowledge/changed.md (verified at");
    expect(out).toContain("1 cited range(s) changed");
    expect(out).toContain("cited lines unchanged");
    expect(out).toContain("cites none of the changed files");
    expect(out.indexOf("knowledge/changed.md")).toBeLessThan(out.indexOf("knowledge/still.md"));
    expect(out.indexOf("knowledge/still.md")).toBeLessThan(out.indexOf("knowledge/elsewhere.md"));
  });
});

const headOf = (dir: string) =>
  Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: dir }).stdout.toString().trim();

describe("accreta drift for a pull request", () => {
  /** One diff: cited lines of `first`, uncited lines of `second`'s file, nothing of `third`'s. */
  async function fixture(): Promise<{ from: string; to: string }> {
    await cli("init");
    rmSync(join(root, "sources", "example.yaml"), { force: true });

    const docs = join(root, "sources", "docs");
    mkdirSync(docs, { recursive: true });
    const git = async (...args: string[]) => {
      const proc = Bun.spawn(["git", ...args], { cwd: docs, stdout: "pipe", stderr: "pipe" });
      if ((await proc.exited) !== 0) throw new Error(await new Response(proc.stderr).text());
    };
    for (const name of ["a.md", "b.md", "c.md"]) writeFileSync(join(docs, name), twentyLines());
    await git("init", "-q");
    await git("config", "user.email", "t@example.invalid");
    await git("config", "user.name", "Test");
    await git("add", ".");
    await git("commit", "-qm", "base");
    const from = headOf(docs);

    writeFileSync(
      join(root, "sources", "docs.yaml"),
      "id: docs\ntype: git\nroot: sources/docs\n",
      "utf-8",
    );
    const page = (name: string, citation: string) =>
      writePage(
        `${name}.md`,
        `---\ntype: note\nsource: docs\nlast_verified_revision: ${from}\n---\n\n# ${name}\n\n` +
          `A claim.[^c]\n\n[^c]: docs @ ${from.slice(0, 7)} · ${citation}\n`,
      );
    page("first", "a.md#L3-L5");
    page("second", "b.md#L2-L4");
    page("third", "c.md#L1-L2");
    await cli("reindex");

    writeFileSync(join(docs, "a.md"), twentyLines({ 4: "rewritten" }), "utf-8");
    writeFileSync(join(docs, "b.md"), twentyLines({ 15: "rewritten" }), "utf-8");
    await git("commit", "-qam", "the pull request");
    output = [];
    return { from, to: headOf(docs) };
  }

  test("--json names only the page whose cited lines changed", async () => {
    const { from, to } = await fixture();

    expect(await cli("drift", "--json")).toBe(1);
    const report = JSON.parse(stdout());
    expect(report.pages_in_doubt).toBe(1);
    expect(report.sources).toHaveLength(1);
    const [source] = report.sources;
    expect(source.current_revision).toBe(to);
    expect(source.in_doubt).toEqual([
      {
        page: "knowledge/first.md",
        verified_at: from,
        citations: [
          {
            footnote: "c",
            path: "a.md",
            locator: "L3-L5",
            cited_at: from.slice(0, 7),
            change: "touched",
          },
        ],
      },
    ]);
    expect(source.repin).toEqual([]);
    // Counted, not named: untouched lines of a touched file lower the doubt without clearing it.
    expect(source.other_stale_pages).toBe(2);
    expect(stdout()).not.toContain("second");
    expect(stdout()).not.toContain("third");
  });

  test("--format github names the page, its cited lines and the commits, and no other page", async () => {
    const { from, to } = await fixture();

    expect(await cli("drift", "--format", "github")).toBe(1);
    const out = stdout();
    expect(out).toContain("**1 page in doubt:**");
    expect(out).toContain(`\`docs\` at \`${to}\`. Re-pin after merge`);
    expect(out).toContain(
      `| \`knowledge/first.md\` | \`a.md#L3-L5\` \`[^c]\` | \`${from.slice(0, 7)}\` | changed |`,
    );
    expect(out).toContain("2 other page(s) were verified before this change");
    expect(out).not.toContain("second");
    expect(out).not.toContain("third");
  });

  test("lines that only moved are listed for re-pinning, not in doubt", async () => {
    const { from } = await fixture();
    const docs = join(root, "sources", "docs");
    writeFileSync(join(docs, "c.md"), "inserted\n" + twentyLines(), "utf-8");
    Bun.spawnSync(["git", "commit", "-qam", "shift c"], { cwd: docs });

    expect(await cli("drift", "--json")).toBe(1);
    const [source] = JSON.parse(stdout()).sources;
    expect(source.in_doubt.map((p: { page: string }) => p.page)).toEqual(["knowledge/first.md"]);
    expect(source.repin).toEqual([
      {
        page: "knowledge/third.md",
        verified_at: from,
        citations: [
          {
            footnote: "c",
            path: "c.md",
            locator: "L1-L2",
            cited_at: from.slice(0, 7),
            now: "L2-L3",
          },
        ],
      },
    ]);

    output = [];
    await cli("drift", "--format", "github");
    expect(stdout()).toContain("1 page(s) only need re-pinning");
    expect(stdout()).toContain(
      `| \`knowledge/third.md\` | \`c.md#L1-L2\` \`[^c]\` | \`${from.slice(0, 7)}\` | \`L2-L3\` |`,
    );
  });

  test("a knowledge base verified at the new commit is clean in every format", async () => {
    const { to } = await fixture();
    for (const name of ["first", "second", "third"]) {
      writePage(
        `${name}.md`,
        `---\ntype: note\nsource: docs\nlast_verified_revision: ${to}\n---\n\n# ${name}\n`,
      );
    }
    await cli("reindex");
    output = [];

    expect(await cli("drift", "--format", "github")).toBe(0);
    expect(stdout()).toContain("**No page in doubt.**");
    expect(stdout()).toContain(`\`docs\` at \`${to}\`: up to date.`);
    output = [];
    expect(await cli("drift", "--json")).toBe(0);
    expect(JSON.parse(stdout()).pages_in_doubt).toBe(0);
  });

  test("a revision the source cannot place is not reported as clean", async () => {
    await cli("init");
    rmSync(join(root, "sources", "example.yaml"), { force: true });
    mkdirSync(join(root, "sources", "docs"), { recursive: true });
    writeFileSync(join(root, "sources", "docs", "a.md"), "text", "utf-8");
    writeFileSync(
      join(root, "sources", "docs.yaml"),
      'id: docs\ntype: fs\nroot: sources/docs\nextensions: [".md"]\n',
      "utf-8",
    );
    writePage("a.md", "---\ntype: note\nsource: docs\nlast_verified_revision: gone\n---\n\n# A\n");
    await cli("reindex");
    output = [];

    expect(await cli("drift", "--format", "github")).toBe(1);
    expect(stdout()).toContain("but some revisions cannot be placed");
    expect(stdout()).toContain("1 page(s) were verified at a revision this source cannot place");
    expect(stdout()).not.toContain("No page in doubt");
  });

  test("an unknown format or flag is refused rather than ignored", async () => {
    await fixture();
    for (const [argv, says] of [
      [["--format", "html"], "--format takes text, json or github"],
      [["--format"], "--format takes"],
      [["--jsn"], "drift does not take --jsn"],
      [["github"], 'drift does not take "github"'],
      [["--json", "github", "extra"], 'drift does not take "github"'],
      [["--base", "--json"], "--base takes the path"],
    ] as const) {
      errors = [];
      expect(await cli("drift", ...argv)).toBe(2);
      expect(stderr()).toContain(says);
    }
  });

  test("flag values can be joined with =", async () => {
    await fixture();
    expect(await cli("drift", "--format=json")).toBe(1);
    expect(JSON.parse(stdout()).pages_in_doubt).toBe(1);
  });
});

describe("accreta drift --base", () => {
  /** Pages verified at a first commit: `first` cites a.md, `second` b.md, `third` c.md. */
  async function repo() {
    await cli("init");
    rmSync(join(root, "sources", "example.yaml"), { force: true });
    const docs = join(root, "sources", "docs");
    mkdirSync(docs, { recursive: true });
    const git = async (...args: string[]) => {
      const proc = Bun.spawn(["git", ...args], { cwd: docs, stdout: "pipe", stderr: "pipe" });
      if ((await proc.exited) !== 0) throw new Error(await new Response(proc.stderr).text());
    };
    for (const name of ["a.md", "b.md", "c.md"]) writeFileSync(join(docs, name), twentyLines());
    await git("init", "-q");
    await git("config", "user.email", "t@example.invalid");
    await git("config", "user.name", "Test");
    await git("add", ".");
    await git("commit", "-qm", "verified");
    const from = headOf(docs);
    writeFileSync(
      join(root, "sources", "docs.yaml"),
      "id: docs\ntype: git\nroot: sources/docs\n",
      "utf-8",
    );
    for (const [name, citation] of [
      ["first", "a.md#L3-L5"],
      ["second", "b.md#L2-L4"],
      ["third", "c.md#L1-L2"],
    ] as const) {
      writePage(
        `${name}.md`,
        `---\ntype: note\nsource: docs\nlast_verified_revision: ${from}\n---\n\n# ${name}\n\n` +
          `A claim.[^c]\n\n[^c]: docs @ ${from.slice(0, 7)} · ${citation}\n`,
      );
    }
    await cli("reindex");
    const edit = async (file: string, lines: Record<number, string>) => {
      writeFileSync(join(docs, file), twentyLines(lines), "utf-8");
      await git("commit", "-qam", `edit ${file}`);
    };
    const baseReport = async () => {
      output = [];
      await cli("drift", "--json");
      writeFileSync(join(root, "base.json"), stdout(), "utf-8");
      output = [];
    };
    const repin = async (name: string, citation: string) => {
      const now = headOf(docs);
      writePage(
        `${name}.md`,
        `---\ntype: note\nsource: docs\nlast_verified_revision: ${now}\n---\n\n# ${name}\n\n` +
          `A claim.[^c]\n\n[^c]: docs @ ${now.slice(0, 7)} · ${citation}\n`,
      );
      await cli("reindex");
      output = [];
    };
    return { from, edit, baseReport, repin };
  }

  test("a line the base branch already touched stays listed, apart from the new ones", async () => {
    const { edit, baseReport } = await repo();
    await edit("a.md", { 4: "changed on the base branch" });
    await baseReport();
    await edit("a.md", { 4: "changed on the base branch", 5: "and again here" });
    await edit("c.md", { 1: "changed here" });

    expect(await cli("drift", "--json", "--base", "base.json")).toBe(1);
    const report = JSON.parse(stdout());
    expect(report.pages_in_doubt).toBe(2);
    expect(report.pages_newly_in_doubt).toBe(1);
    const cited = report.sources[0].in_doubt.map(
      (p: { page: string; citations: { on_base: boolean }[] }) => [p.page, p.citations[0]!.on_base],
    );
    expect(cited).toEqual([
      ["knowledge/first.md", true],
      ["knowledge/third.md", false],
    ]);

    output = [];
    expect(await cli("drift", "--format", "github", "--base", "base.json")).toBe(1);
    const out = stdout();
    expect(out).toContain("**1 page newly in doubt:**");
    const third = out.indexOf("| `knowledge/third.md` |");
    const already = out.indexOf("<summary>1 page(s) were already in doubt on the base branch.");
    const first = out.indexOf("| `knowledge/first.md` |");
    expect(third).toBeGreaterThan(-1);
    expect(already).toBeGreaterThan(third);
    expect(first).toBeGreaterThan(already);
  });

  test("an edit to an uncited line alone puts no page newly in doubt, though drift exits 1", async () => {
    const { edit, baseReport } = await repo();
    await baseReport();
    await edit("b.md", { 15: "uncited" });

    expect(await cli("drift", "--json", "--base", "base.json")).toBe(1);
    const report = JSON.parse(stdout());
    expect(report.pages_newly_in_doubt).toBe(0);
    expect(report.sources[0].in_doubt).toEqual([]);
    output = [];
    await cli("drift", "--format", "github", "--base", "base.json");
    expect(stdout()).toContain("**No page newly in doubt.** No line any page cites has changed.");
  });

  test("a citation re-pinned since the base and broken again is new", async () => {
    const { edit, baseReport, repin } = await repo();
    await edit("a.md", { 4: "changed on the base branch" });
    await baseReport();
    await repin("first", "a.md#L3-L5");
    await edit("a.md", { 4: "changed on the base branch", 5: "broken again" });

    expect(await cli("drift", "--json", "--base", "base.json")).toBe(1);
    const report = JSON.parse(stdout());
    expect(report.pages_newly_in_doubt).toBe(1);
    expect(report.sources[0].in_doubt[0].citations[0].on_base).toBe(false);
  });

  test("a page newly at a revision nobody can place counts; one the base had does not", async () => {
    await cli("init");
    rmSync(join(root, "sources", "example.yaml"), { force: true });
    mkdirSync(join(root, "sources", "docs"), { recursive: true });
    writeFileSync(join(root, "sources", "docs", "a.md"), "text", "utf-8");
    writeFileSync(
      join(root, "sources", "docs.yaml"),
      'id: docs\ntype: fs\nroot: sources/docs\nextensions: [".md"]\n',
      "utf-8",
    );
    const pin = (revision: string) =>
      writePage(
        "a.md",
        `---\ntype: note\nsource: docs\nlast_verified_revision: ${revision}\n---\n\n# A\n`,
      );
    pin("gone");
    await cli("reindex");
    output = [];
    await cli("drift", "--json");
    writeFileSync(join(root, "base.json"), stdout(), "utf-8");

    output = [];
    await cli("drift", "--json", "--base", "base.json");
    expect(JSON.parse(stdout())).toMatchObject({
      pages_unplaceable: 1,
      pages_newly_unplaceable: 0,
    });

    pin("also-gone");
    await cli("reindex");
    output = [];
    await cli("drift", "--json", "--base", "base.json");
    expect(JSON.parse(stdout())).toMatchObject({
      pages_unplaceable: 1,
      pages_newly_unplaceable: 1,
    });
    output = [];
    await cli("drift", "--json");
    expect(JSON.parse(stdout()).pages_newly_unplaceable).toBe(1);
  });

  test("a base that is not a drift report is refused", async () => {
    await repo();
    writeFileSync(join(root, "base.json"), "{}", "utf-8");
    expect(await cli("drift", "--json", "--base", "base.json")).toBe(2);
    expect(stderr()).toContain("has no sources");
  });
});

describe("drift --format github, rendered", () => {
  const long = "deep/".repeat(60);
  function report(id: string, inDoubt: number, moved: number): DriftReport {
    const pages = Array.from(
      { length: inDoubt + moved },
      (_, i) => `knowledge/${long}${id}-${i}.md`,
    );
    return {
      sourceId: id,
      currentRevision: "b".repeat(40),
      stale: [
        {
          revision: "a".repeat(40),
          changedPaths: [`${long}doc.md`],
          pages,
          citations: pages.map((page, i) => ({
            page,
            footnote: "c",
            path: `${long}doc.md`,
            locator: "L1-L2",
            revision: "a".repeat(40),
            change: i < inDoubt ? { status: "touched" } : { status: "moved", locator: "L3-L4" },
          })),
        },
      ],
      unverifiable: [],
      unresolvable: [],
      delegated: null,
    };
  }

  test("the whole comment stays within one budget, however many sources and rows", () => {
    const out = toGithub([report("one", 150, 150), report("two", 150, 150)]);
    expect(out.length).toBeLessThanOrEqual(GITHUB_BODY_LIMIT);
    const shownRows = out.split("\n").filter((line) => line.startsWith("| `"));
    const shown = shownRows.length;
    // Rows newly in doubt go first; re-pin rows only get what is left.
    expect(shownRows.every((line) => line.endsWith("| changed |"))).toBe(true);
    const more = Number(/…and (\d+) more rows\./.exec(out)?.[1]);
    expect(shown).toBeGreaterThan(0);
    expect(shown + more).toBe(600);
    // A table whose rows were all cut loses its header too.
    const lines = out.split("\n");
    lines.forEach((line, i) => {
      if (line === "|---|---|---|---|") expect(lines[i + 1]).toStartWith("| `");
    });
  });

  test("a value from the repository cannot inject Markdown or HTML", () => {
    const hostile = report("docs", 1, 0);
    const entry = hostile.stale[0]!;
    entry.citations![0]!.locator = "L5-L8<!--@octocat";
    entry.citations![0]!.revision = "abc`def|x";
    const out = toGithub([hostile]);
    expect(out).toContain("doc.md#L5-L8<!--@octocat`");
    expect(out).not.toMatch(/[^`#]L5-L8<!--/);
    expect(out).toContain("| ``abc`def\\|x`` |");
  });

  test("pages at a revision nobody can place are named, and nothing unchecked reads as up to date", () => {
    const out = toGithub([
      {
        sourceId: "docs",
        currentRevision: "b".repeat(40),
        stale: [],
        unverifiable: ["knowledge/loose.md"],
        unresolvable: [{ revision: "gone", pages: ["knowledge/a.md"] }],
        delegated: null,
      },
    ]);
    expect(out).toContain("- `knowledge/a.md`, verified at `gone`");
    expect(out).toContain("1 page(s) record no revision at all.");
    expect(out).not.toContain("up to date");
  });
});

describe("accreta help", () => {
  test("no arguments prints usage", async () => {
    expect(await cli()).toBe(0);
    expect(stdout()).toContain("Usage: accreta");
  });

  test("an unknown command is an error with usage", async () => {
    expect(await cli("frobnicate")).toBe(2);
    expect(stderr()).toContain("Unknown command");
  });

  test("usage names every flag the parser accepts", async () => {
    const source = readFileSync(join(import.meta.dir, "..", "src", "main.ts"), "utf-8");
    const flags = [...source.matchAll(/arg === "(--[a-z-]+)"/g)].map((match) => match[1]!);
    expect(flags.length).toBeGreaterThan(0);

    await cli("help");
    for (const flag of flags) expect(stdout()).toContain(flag);
  });

  test("every flag the parser accepts is accepted by some command", async () => {
    const source = readFileSync(join(import.meta.dir, "..", "src", "main.ts"), "utf-8");
    const flags = [...source.matchAll(/arg === "(--[a-z-]+)"/g)].map((match) => match[1]!);
    const accepted = new Set(Object.values(COMMAND_ARGS).flatMap((spec) => spec.flags));
    expect(flags.filter((flag) => !accepted.has(flag))).toEqual([]);
  });
});

describe("accreta lint — citations", () => {
  function writeSource(name: string, contents: string): void {
    mkdirSync(join(root, "src-docs"), { recursive: true });
    writeFileSync(join(root, "src-docs", name), contents, "utf-8");
    mkdirSync(join(root, "sources"), { recursive: true });
    writeFileSync(
      join(root, "sources", "docs.yaml"),
      "id: docs\ntype: fs\nroot: src-docs\n",
      "utf-8",
    );
  }

  test("a fabricated line range is reported end to end", async () => {
    // The issue's reproduction: a pointer into a real file, past its end. It
    // passed every check the project had and was served as provenance.
    writeSource("doc.md", "one\ntwo\nthree\n");
    writePage(
      "a.md",
      '---\ntype: note\ncanonical_source: "docs:doc.md#L99999"\nlast_verified_revision: r\n---\n\n# A\n',
    );
    await cli("init");
    await cli("reindex");

    expect(await cli("lint")).toBe(1);
    expect(stdout()).toContain("citation-locator-missing");
    expect(stdout()).toContain("knowledge/a.md");
  });

  test("citations into a source only the agent can read are counted, not reported", async () => {
    await cli("init");
    rmSync(join(root, "sources", "example.yaml"), { force: true });
    writeFileSync(
      join(root, "sources", "design-docs.yaml"),
      "id: design-docs\ntype: delegated\nvia: notion\nscope: The Design decisions page.\n",
      "utf-8",
    );
    writePage(
      "a.md",
      "---\ntype: note\nsource: design-docs\nlast_verified_revision: 2026-08-01T10:22:00Z\n" +
        'canonical_source: "design-docs:2f1a4b#block-a1b2c3"\n---\n\n# A\n',
    );
    await cli("reindex");
    output = [];

    // Clean, because nothing was found to be wrong — and a line saying so was
    // not the same as saying it was checked.
    expect(await cli("lint")).toBe(0);
    expect(stdout()).toContain("1 citation(s) could not be checked");
    expect(stdout()).toContain(
      '1  source "design-docs" is read through notion; accreta cannot check it',
    );
    expect(stdout()).toContain("design-docs:2f1a4b");

    output = [];
    await cli("lint", "--json");
    const report = JSON.parse(stdout());
    expect(report.unchecked_reasons[0].paths).toEqual(["design-docs:2f1a4b"]);
    expect(report._provenance.page_derived_fields).toContain("unchecked_reasons[].detail");
    expect(report._provenance.page_derived_fields).toContain("unchecked_reasons[].paths");
  });

  test("a citation that resolves is not reported", async () => {
    writeSource("doc.md", "one\ntwo\nthree\n");
    writePage(
      "a.md",
      '---\ntype: note\ncanonical_source: "docs:doc.md#L2"\nlast_verified_revision: r\n---\n\n# A\n',
    );
    await cli("init");
    await cli("reindex");

    await cli("lint");
    expect(stdout()).not.toContain("citation-");
  });
});

describe("accreta --version", () => {
  // Read back from the manifest rather than restated here: a literal in the
  // test drifts the same way the literal in the source did.
  const manifest = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf-8"),
  ) as { version: string };

  test("the version is the one the package publishes", async () => {
    expect(await cli("--version")).toBe(0);
    expect(stdout()).toContain(manifest.version);
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  test("-v is the same", async () => {
    expect(await cli("-v")).toBe(0);
    expect(stdout()).toContain(manifest.version);
  });
});

describe("accreta source add", () => {
  test("it writes a declaration and immediately says what can reach it", async () => {
    await cli("init");
    mkdirSync(join(root, "corpus"), { recursive: true });
    output = [];

    expect(await cli("source", "add", "fs", "docs", "--set", "root=corpus")).toBe(0);
    const written = readFileSync(join(root, "sources", "docs.yaml"), "utf-8");
    expect(written).toContain("id: docs");
    expect(written).toContain("root: corpus");
    // The template's comments survive an override; they are most of its value.
    expect(written).toContain("hash of modification times");
    expect(stdout()).toContain("ok:");
  });

  test("a delegated source is written unusable, and says why", async () => {
    // The template leaves `scope` empty on purpose: nothing else says what the
    // agent may look at, so it has to be written rather than defaulted.
    await cli("init");
    output = [];

    expect(await cli("source", "add", "delegated", "design-docs", "--set", "via=notion")).toBe(0);
    expect(stdout()).toContain("no: declares no `scope`");
  });

  test("it refuses to overwrite a declaration that is already there", async () => {
    await cli("init");
    await cli("source", "add", "fs", "docs");
    output = [];
    errors = [];

    expect(await cli("source", "add", "fs", "docs")).toBe(1);
    expect(stderr()).toContain("already exists");
  });

  test("an unknown type names the ones this build has", async () => {
    await cli("init");
    errors = [];
    expect(await cli("source", "add", "notion", "docs")).toBe(2);
    expect(stderr()).toContain("delegated");
  });
});

describe("accreta doctor", () => {
  // doctor looks for the setup skill under HOME; keep it off the real one.
  const saved = { HOME: process.env.HOME, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR };
  beforeEach(() => {
    process.env.HOME = root;
    delete process.env.CLAUDE_CONFIG_DIR;
  });
  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  test("a source it cannot reach fails; one it cannot check does not", async () => {
    await cli("init");
    rmSync(join(root, "sources", "example.yaml"), { force: true });
    writeFileSync(
      join(root, "sources", "design-docs.yaml"),
      "id: design-docs\ntype: delegated\nvia: notion\nscope: The Design decisions page.\n",
      "utf-8",
    );
    output = [];

    // "unknown" is not a failure. accreta genuinely cannot look, and exiting 1
    // would make an honest answer indistinguishable from a broken setup.
    expect(await cli("doctor")).toBe(0);
    expect(stdout()).toContain("unknown: accreta cannot check this source");
    expect(stdout()).toContain("your agent needs: notion — unverified");
  });

  test("a directory that is not there is a failure with a remedy", async () => {
    await cli("init");
    output = [];

    expect(await cli("doctor")).toBe(1);
    expect(stdout()).toContain("does not exist");
    expect(stdout()).toContain("→ Create it");
  });

  test("a half-written declaration is reported, not thrown", async () => {
    await cli("init");
    rmSync(join(root, "sources", "example.yaml"), { force: true });
    writeFileSync(
      join(root, "sources", "x.yaml"),
      "id: x\ntype: delegated\nvia: notion\n",
      "utf-8",
    );
    output = [];

    expect(await cli("doctor")).toBe(1);
    expect(stdout()).toContain("declares no `scope`");
  });

  test("a config that silently reverted to the defaults is named", async () => {
    // `parseConfig` swallows a syntax error and hands back the defaults, which
    // is right where a page is being read and invisible everywhere else.
    await cli("init");
    rmSync(join(root, "sources", "example.yaml"), { force: true });
    writeFileSync(join(root, "accreta.config.yaml"), "page_types: [a\n  - broken", "utf-8");
    output = [];

    expect(await cli("doctor")).toBe(1);
    expect(stdout()).toContain("did not parse");
    expect(stdout()).toContain("default vocabulary");
  });

  test("a provenance format left on the old placeholders is flagged", async () => {
    await cli("init");
    rmSync(join(root, "sources", "example.yaml"), { force: true });
    writeFileSync(
      join(root, "accreta.config.yaml"),
      'knowledge_base: knowledge\nprovenance:\n  format: "{source} @ {rev} · {path}#L{start}-L{end}"\n',
      "utf-8",
    );
    output = [];

    await cli("doctor");
    expect(stdout()).toContain("still uses {start} and {end}");
  });

  test("a provenance format footnotes cannot be read back through is flagged", async () => {
    await cli("init");
    rmSync(join(root, "sources", "example.yaml"), { force: true });
    writeFileSync(
      join(root, "accreta.config.yaml"),
      'knowledge_base: knowledge\nprovenance:\n  format: "{source}{path}"\n',
      "utf-8",
    );
    output = [];

    expect(await cli("doctor")).toBe(1);
    expect(stdout()).toContain("side by side");
  });

  test("an unknown source type is a finding rather than a crash", async () => {
    await cli("init");
    rmSync(join(root, "sources", "example.yaml"), { force: true });
    writeFileSync(join(root, "sources", "x.yaml"), "id: x\ntype: confluence\n", "utf-8");
    output = [];

    expect(await cli("doctor")).toBe(1);
    expect(stdout()).toContain("unknown source type");
  });
});
