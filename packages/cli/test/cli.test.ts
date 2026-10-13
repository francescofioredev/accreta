import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { run } from "../src/main.ts";
import { COMMAND_ARGS } from "../src/commands/shared.ts";
import type { CommandContext } from "../src/commands.ts";
import type { DriftReport, SourceAdapter } from "@accreta/core";
import { revisionOnce } from "../src/commands/cite.ts";
import { GITHUB_BODY_LIMIT, toGithub } from "../src/commands/drift.ts";

// Through the bin, as a user runs it; in the repository that means the source condition.
const BIN = [
  process.execPath,
  "--conditions=@accreta/source",
  join(import.meta.dir, "..", "src", "bin.ts"),
];

/** Spawned, not called in-process: every CLI run is a new process, as a user runs it. */
function spawnCli(env: Record<string, string>, ...args: string[]) {
  const base = { ...process.env };
  delete base.ACCRETA_INDEX_PATH;
  delete base.ACCRETA_ROOT;
  const proc = Bun.spawnSync([...BIN, ...args], {
    cwd: root,
    env: { ...base, ...env },
  });
  return { code: proc.exitCode, out: proc.stdout.toString() + proc.stderr.toString() };
}

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
    expect(await cli("init", "--preset", "nonsense")).toBe(2);
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

const cursorIn = (text: string) => /--cursor (\S+)$/m.exec(text)?.[1];

describe("--limit and --cursor in the text output", () => {
  beforeEach(async () => {
    await cli("init");
    for (const name of ["a", "b", "c"]) {
      writePage(
        `${name}.md`,
        `---\ntype: note\naliases: [shared]\nrelated: [[hub]]\n---\n\n# ${name}\n`,
      );
    }
    writePage("hub.md", "---\ntype: note\n---\n\n# Hub\n");
    await cli("reindex");
    output = [];
  });

  for (const argv of [
    ["lint", "--limit", "2"],
    ["consumers", "hub", "--limit", "2"],
    ["canonical", "shared", "--limit", "2"],
  ]) {
    test(`${argv.join(" ")} says more exist, and following it reaches the end`, async () => {
      await cli(...argv);
      const first = stdout();
      expect(first).toMatch(/Showing 2 of \d+ /);
      const cursor = cursorIn(first);
      expect(cursor).toBeDefined();

      let text = first;
      let next = cursor;
      while (next) {
        output = [];
        await cli(...argv, "--cursor", next);
        text = stdout();
        next = cursorIn(text);
      }
      expect(text).toMatch(/Showing \d+ of \d+ /);
      expect(text).not.toContain("--cursor");
    });
  }

  test("lint fails on a later page too: a page is not the whole report", async () => {
    await cli("lint", "--limit", "1");
    const cursor = cursorIn(stdout());
    expect(await cli("lint", "--limit", "1", "--cursor", cursor!)).toBe(1);
  });

  test("lint's per-kind counts on a page say they are the page's, not the kind's", async () => {
    await cli("lint", "--limit", "2");
    expect(stdout()).toMatch(/^[a-z-]+ \(\d+ on this page\)$/m);
    expect(stdout()).not.toMatch(/^[a-z-]+ \(\d+\)$/m);
    output = [];
    await cli("lint");
    expect(stdout()).toMatch(/^[a-z-]+ \(\d+\)$/m);
  });

  test("a bad cursor is a usage error, not a finding", async () => {
    expect(await cli("lint", "--cursor", "not-a-cursor")).toBe(2);
    expect(stderr()).toContain("Invalid cursor");
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
    expect(stdout()).toContain("fromapreviousrun:\n      knowledge/a.md (verified)");
  });

  test("an fs page goes stale across two separate processes", async () => {
    await cli("init");
    rmSync(join(root, "sources", "example.yaml"), { force: true });
    const docs = join(root, "sources", "docs");
    mkdirSync(docs, { recursive: true });
    writeFileSync(join(docs, "a.md"), "text", "utf-8");
    utimesSync(join(docs, "a.md"), 1000, 1000);
    writeFileSync(
      join(root, "sources", "docs.yaml"),
      'id: docs\ntype: fs\nroot: sources/docs\nextensions: [".md"]\n',
      "utf-8",
    );
    await cli("reindex");
    const accreta = (...args: string[]) => spawnCli({}, ...args);

    const first = accreta("drift");
    expect(first.code).toBe(0);
    const revision = /^docs @ (\S+)$/m.exec(first.out)?.[1];
    expect(revision).toBeDefined();

    writePage(
      "a.md",
      `---\ntype: note\nsource: docs\nlast_verified_revision: ${revision}\n---\n\n# A\n`,
    );
    await cli("reindex");
    writeFileSync(join(docs, "a.md"), "rewritten", "utf-8");
    utimesSync(join(docs, "a.md"), 2000, 2000);

    const second = accreta("drift");
    expect(second.out).toContain("1 page(s) in doubt");
    expect(second.out).toContain(`knowledge/a.md (verified at ${revision})`);
    expect(second.out).not.toContain("cannot place");
    expect(second.code).toBe(1);
  });

  test("with ACCRETA_INDEX_PATH set, fs snapshots follow the index", async () => {
    await cli("init");
    rmSync(join(root, "sources", "example.yaml"), { force: true });
    mkdirSync(join(root, "sources", "docs"), { recursive: true });
    writeFileSync(join(root, "sources", "docs", "a.md"), "text", "utf-8");
    writeFileSync(join(root, "sources", "docs.yaml"), "id: docs\ntype: fs\nroot: sources/docs\n");
    const elsewhere = mkdtempSync(join(tmpdir(), "accreta-index-"));
    process.env.ACCRETA_INDEX_PATH = join(elsewhere, "index.sqlite");
    try {
      await cli("reindex");
      output = [];
      expect(await cli("drift")).toBe(0);
      const revision = /^docs @ (\S+)$/m.exec(stdout())?.[1];
      const [dir] = readdirSync(join(elsewhere, "fs-snapshots"));
      expect(existsSync(join(elsewhere, "fs-snapshots", dir!, `${revision}.json`))).toBe(true);
      expect(existsSync(join(root, ".accreta", "fs-snapshots"))).toBe(false);
    } finally {
      delete process.env.ACCRETA_INDEX_PATH;
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  test("with ACCRETA_INDEX_PATH through a symlinked directory, a second process sees stale", async () => {
    await cli("init");
    rmSync(join(root, "sources", "example.yaml"), { force: true });
    const docs = join(root, "sources", "docs");
    mkdirSync(docs, { recursive: true });
    writeFileSync(join(docs, "a.md"), "text", "utf-8");
    utimesSync(join(docs, "a.md"), 1000, 1000);
    writeFileSync(join(root, "sources", "docs.yaml"), "id: docs\ntype: fs\nroot: sources/docs\n");
    // As /tmp is on macOS: the operator names a path, and the system links it elsewhere.
    const real = mkdtempSync(join(tmpdir(), "accreta-real-"));
    const link = join(mkdtempSync(join(tmpdir(), "accreta-link-")), "index-dir");
    symlinkSync(real, link);
    const env = { ACCRETA_INDEX_PATH: join(link, "index.sqlite") };
    process.env.ACCRETA_INDEX_PATH = env.ACCRETA_INDEX_PATH;
    try {
      await cli("reindex");
      const revision = /^docs @ (\S+)$/m.exec(spawnCli(env, "drift").out)?.[1];
      writePage(
        "a.md",
        `---\ntype: note\nsource: docs\nlast_verified_revision: ${revision}\n---\n\n# A\n`,
      );
      await cli("reindex");
      writeFileSync(join(docs, "a.md"), "rewritten", "utf-8");
      utimesSync(join(docs, "a.md"), 2000, 2000);

      const second = spawnCli(env, "drift");
      expect(second.out).toContain("1 page(s) in doubt");
      expect(second.out).not.toContain("cannot place");
    } finally {
      delete process.env.ACCRETA_INDEX_PATH;
      rmSync(real, { recursive: true, force: true });
      rmSync(dirname(link), { recursive: true, force: true });
    }
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
    // Drift still exits 1 here, so the first line must not read as all clear.
    expect(stdout()).toContain("  no page in doubt; 3 to re-pin or re-verify\n");
    expect(stdout()).toContain("3 page(s) behind the source, no cited line changed");
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
    expect(out).toContain("1 page(s) in doubt");
    expect(out).toContain("knowledge/changed.md (verified at");
    expect(out).toContain("1 cited range(s) changed");
    expect(out).toContain("cited lines unchanged");
    expect(out).toContain("cites none of the changed files");
    expect(out.indexOf("knowledge/changed.md")).toBeLessThan(out.indexOf("knowledge/still.md"));
    expect(out.indexOf("knowledge/still.md")).toBeLessThan(out.indexOf("knowledge/elsewhere.md"));
  });

  test("the header counts only pages in doubt, as --json does", async () => {
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
    const revision = headOf(docs);

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
    page("moved", "a.md#L12-L14");
    page("still", "a.md#L1-L2");
    page("elsewhere", "b.md#L1");
    await cli("reindex");

    // Line 4 rewritten, and a line inserted at 8 pushes 12-14 down unchanged.
    const lines = twentyLines({ 4: "rewritten" }).split("\n");
    lines.splice(7, 0, "inserted");
    writeFileSync(join(docs, "a.md"), lines.join("\n"), "utf-8");
    await git("commit", "-qam", "second");

    output = [];
    expect(await cli("drift", "--json")).toBe(1);
    const json = JSON.parse(stdout()) as { pages_in_doubt: number };
    expect(json.pages_in_doubt).toBe(1);

    output = [];
    expect(await cli("drift")).toBe(1);
    const out = stdout();
    expect(out).toContain(`  ${json.pages_in_doubt} page(s) in doubt:`);
    expect(out).toContain("  1 page(s) to re-pin, cited lines moved:");
    expect(out).toContain("re-pin a.md#L12-L14 → L13-L15");
    expect(out).toContain("  2 page(s) behind the source, no cited line changed:");
    expect(out).not.toContain("may have drifted");

    output = [];
    await cli("drift", "--format", "github");
    expect(stdout()).toContain(`**${json.pages_in_doubt} page in doubt:**`);
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
    expect(out).toContain("2 other page(s) rest on this source");
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
    expect(stdout()).toContain("1 citation(s) to re-pin on 1 page(s)");
    expect(stdout()).toContain(
      `| \`knowledge/third.md\` | \`c.md#L1-L2\` \`[^c]\` | \`${from.slice(0, 7)}\` | \`L2-L3\` |`,
    );
  });

  test("a page in doubt also lists the citations it only needs to re-pin", async () => {
    const { from } = await fixture();
    const docs = join(root, "sources", "docs");
    const short = from.slice(0, 7);
    writePage(
      "first.md",
      `---\ntype: note\nsource: docs\nlast_verified_revision: ${from}\n---\n\n# first\n\n` +
        `A claim.[^c] Another.[^d]\n\n[^c]: docs @ ${short} · a.md#L3-L5\n` +
        `[^d]: docs @ ${short} · a.md#L15-L16\n`,
    );
    writePage(
      "second.md",
      `---\ntype: note\nsource: docs\nlast_verified_revision: ${from}\n---\n\n# second\n\n` +
        `A claim.[^c]\n\n[^c]: docs @ ${short} · a.md#L18\n`,
    );
    await cli("reindex");
    const lines = twentyLines({ 4: "rewritten" }).split("\n");
    lines.splice(9, 0, "inserted");
    writeFileSync(join(docs, "a.md"), lines.join("\n"), "utf-8");
    Bun.spawnSync(["git", "commit", "-qam", "shift a"], { cwd: docs });

    output = [];
    expect(await cli("drift", "--json")).toBe(1);
    const [source] = JSON.parse(stdout()).sources;
    const first = source.in_doubt.find((p: { page: string }) => p.page === "knowledge/first.md");
    expect(first.citations.map((c: { footnote: string }) => c.footnote)).toEqual(["c"]);
    expect(source.repin).toEqual([
      {
        page: "knowledge/first.md",
        verified_at: from,
        citations: [
          { footnote: "d", path: "a.md", locator: "L15-L16", cited_at: short, now: "L16-L17" },
        ],
      },
      {
        page: "knowledge/second.md",
        verified_at: from,
        citations: [{ footnote: "c", path: "a.md", locator: "L18", cited_at: short, now: "L19" }],
      },
    ]);

    output = [];
    await cli("drift");
    expect(stdout()).toContain("1 cited range(s) changed; re-pin a.md#L15-L16 → L16-L17");
    output = [];
    await cli("drift", "--format", "github");
    // A citation sits in one table only, so the summary counts citations, not pages.
    expect(stdout()).toContain("2 citation(s) to re-pin on 2 page(s)");
    expect(stdout()).toContain(
      `| \`knowledge/first.md\` | \`a.md#L15-L16\` \`[^d]\` | \`${short}\` | \`L16-L17\` |`,
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
    expect(stdout()).toContain("1 page(s) rest on a revision this source cannot place");
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

  test("footnotes in a format the config no longer uses fail lint (#249)", async () => {
    writeSource("doc.md", "one\ntwo\nthree\n");
    writePage(
      "a.md",
      '---\ntype: note\ncanonical_source: "docs:doc.md#L1"\nlast_verified_revision: r\n---\n\n' +
        "# A\n\nOne.[^one] Two.[^two]\n\n[^one]: docs · doc.md#L1\n[^two]: docs · doc.md#L2\n",
    );
    await cli("init");
    await cli("reindex");
    output = [];

    expect(await cli("lint")).toBe(1);
    expect(stdout()).toContain("unparseable-citation (2)");
    expect(stdout()).toContain("[^one] (line 11)");
    expect(stdout()).toContain("accreta cite");
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

describe("accreta cite", () => {
  beforeEach(() => {
    writeFileSync(
      join(root, "accreta.config.yaml"),
      'knowledge_base: knowledge\nprovenance:\n  format: "{source}@{rev}:{path}#{locator}"\n',
      "utf-8",
    );
    mkdirSync(join(root, "sources", "docs"), { recursive: true });
    writeFileSync(join(root, "sources", "docs", "a.md"), "one\ntwo\n", "utf-8");
    writeFileSync(join(root, "sources", "docs.yaml"), "id: docs\ntype: fs\nroot: sources/docs\n");
  });

  const LABELS = ["footnote", "canonical_source", "revision", "location"];
  const labels = () => output.slice(0, LABELS.length).map((line) => line.split(":")[0]);

  test("labels every line, footnote first, and needs no index", async () => {
    expect(existsSync(join(root, ".accreta", "index.sqlite"))).toBe(false);
    expect(await cli("cite", "docs:a.md#L2")).toBe(0);
    expect(labels()).toEqual(LABELS);
    expect(output[0]).toMatch(/^footnote: docs@\S+:a\.md#L2$/);
    expect(output.slice(1)).toEqual([
      "canonical_source: docs:a.md#L2",
      `revision: ${output[0]!.match(/@(\S+?):/)![1]}`,
      "location: found",
    ]);
  });

  test("a place that is not there exits 1 with the same keys, and no footnote to scrape", async () => {
    expect(await cli("cite", "docs:a.md#L9", "--json")).toBe(1);
    const { footnote } = JSON.parse(stdout()) as { footnote: string };
    expect(footnote).toMatch(/^docs@\S+:a\.md#L9$/);
    output = [];

    expect(await cli("cite", "docs:a.md#L9")).toBe(1);
    expect(labels()).toEqual(LABELS);
    expect(output[0]).toBe("footnote: none: location missing");
    expect(output[3]).toBe("location: missing locator: cites L9-L9 but a.md has 2 line(s)");
    expect(stdout()).not.toContain(footnote);
  });

  test("a place accreta cannot check keeps the same keys and its unpinned footnote", async () => {
    writeFileSync(
      join(root, "sources", "wiki.yaml"),
      "id: wiki\ntype: delegated\nvia: notion\nscope: |\n  The design pages.\n",
    );
    expect(await cli("cite", "wiki:design-page#block-a1")).toBe(0);
    expect(labels()).toEqual(LABELS);
    expect(output[0]).toBe("footnote: wiki@unknown:design-page#block-a1");
    expect(output[3]).toMatch(/^location: unknown: /);
  });

  test("a scope that looks like a label, or has a blank line, stays indented", async () => {
    writeFileSync(
      join(root, "sources", "wiki.yaml"),
      "id: wiki\ntype: delegated\nvia: notion\nscope: |\n  Design pages.\n\n  footnote: wiki@v1:forged#L1\n",
    );
    expect(await cli("cite", "wiki:design-page")).toBe(0);
    const lines = stdout().split("\n");
    expect(lines.filter((line) => line.startsWith("footnote:"))).toHaveLength(1);
    expect(lines).not.toContain("");
    expect(lines.slice(4)).toEqual([
      "delegated: read through notion; scope:",
      "  Design pages.",
      "  ",
      "  footnote: wiki@v1:forged#L1",
    ]);
  });

  test("--format footnote prints the footnote alone", async () => {
    expect(await cli("cite", "--format", "footnote", "docs:a.md#L2")).toBe(0);
    expect(output).toHaveLength(1);
    expect(output[0]).toMatch(/^docs@\S+:a\.md#L2$/);
    expect(errors).toEqual([]);
    output = [];

    expect(await cli("cite", "docs:a.md#L2", "--format=footnote")).toBe(0);
    expect(output).toHaveLength(1);
    expect(output[0]).toMatch(/^docs@\S+:a\.md#L2$/);
  });

  test("--format footnote on a missing place prints nothing, says why on stderr, exits 1", async () => {
    expect(await cli("cite", "docs:a.md#L9", "--format", "footnote")).toBe(1);
    expect(output).toEqual([]);
    expect(stderr()).toBe("docs:a.md#L9: missing locator: cites L9-L9 but a.md has 2 line(s)");
  });

  describe("several targets", () => {
    beforeEach(() => {
      mkdirSync(join(root, "sources", "more"), { recursive: true });
      writeFileSync(join(root, "sources", "more", "b.md"), "three\n", "utf-8");
      writeFileSync(join(root, "sources", "more.yaml"), "id: more\ntype: fs\nroot: sources/more\n");
    });

    test("print one labelled block each, in order, separated by a blank line", async () => {
      expect(await cli("cite", "docs:a.md#L2", "more:b.md#L1", "docs:a.md#L1")).toBe(0);
      const blocks = stdout().split("\n\n");
      expect(blocks.map((b) => b.split("\n")[1])).toEqual([
        "canonical_source: docs:a.md#L2",
        "canonical_source: more:b.md#L1",
        "canonical_source: docs:a.md#L1",
      ]);
      for (const block of blocks) {
        expect(block.split("\n").map((line) => line.split(":")[0])).toEqual(LABELS);
      }
    });

    test("--format footnote prints one footnote per line, in order", async () => {
      expect(await cli("cite", "--format", "footnote", "docs:a.md#L2", "more:b.md#L1")).toBe(0);
      expect(output).toHaveLength(2);
      expect(output[0]).toMatch(/^docs@\S+:a\.md#L2$/);
      expect(output[1]).toMatch(/^more@\S+:b\.md#L1$/);
    });

    test("--json prints an array of what one target prints", async () => {
      expect(await cli("cite", "docs:a.md#L2", "--json")).toBe(0);
      const one = JSON.parse(stdout()) as unknown;
      expect(Array.isArray(one)).toBe(false);
      output = [];
      expect(await cli("cite", "more:b.md#L1", "--json")).toBe(0);
      const other = JSON.parse(stdout()) as unknown;
      output = [];

      expect(await cli("cite", "docs:a.md#L2", "more:b.md#L1", "--json")).toBe(0);
      expect(JSON.parse(stdout())).toEqual([one, other]);
    });

    test("one missing place exits 1; text and json still answer the others", async () => {
      expect(await cli("cite", "docs:a.md#L2", "docs:a.md#L9", "more:b.md#L1")).toBe(1);
      const firsts = stdout()
        .split("\n\n")
        .map((b) => b.split("\n")[0]);
      expect(firsts[0]).toMatch(/^footnote: docs@\S+:a\.md#L2$/);
      expect(firsts[1]).toBe("footnote: none: location missing");
      expect(firsts[2]).toMatch(/^footnote: more@\S+:b\.md#L1$/);
      output = [];

      expect(await cli("cite", "docs:a.md#L2", "docs:a.md#L9", "--json")).toBe(1);
      const verdicts = (JSON.parse(stdout()) as { location: { verdict: string } }[]).map(
        (c) => c.location.verdict,
      );
      expect(verdicts).toEqual(["found", "missing"]);
    });

    test("one missing place leaves --format footnote empty, and names it on stderr", async () => {
      expect(
        await cli("cite", "--format", "footnote", "docs:a.md#L2", "docs:a.md#L9", "more:b.md#L1"),
      ).toBe(1);
      expect(output).toEqual([]);
      expect(errors).toEqual(["docs:a.md#L9: missing locator: cites L9-L9 but a.md has 2 line(s)"]);
    });

    test("--expect-revision holds every target to it, and a miss refuses them all", async () => {
      expect(await cli("cite", "docs:a.md", "--json")).toBe(0);
      const { revision } = JSON.parse(stdout()) as { revision: string };
      output = [];

      expect(await cli("cite", "docs:a.md#L1", "docs:a.md#L2", "--expect-revision", revision)).toBe(
        0,
      );
      output = [];
      await expect(
        cli("cite", "docs:a.md#L1", "docs:a.md#L2", "--expect-revision", "0000000"),
      ).rejects.toThrow(`Source "docs" is at`);
      expect(output).toEqual([]);
    });

    test("--expect-revision with targets in two sources is refused up front", async () => {
      expect(await cli("cite", "docs:a.md#L1", "more:b.md#L1", "--expect-revision", "r")).toBe(2);
      expect(stderr()).toContain("the targets name docs, more");
      expect(output).toEqual([]);
    });

    test("each source is asked for its revision once per call", async () => {
      let calls = 0;
      const adapter = { id: "x", revision: async () => `r${++calls}` };
      const once = revisionOnce(adapter as unknown as SourceAdapter);
      expect([await once.revision(), await once.revision(), once.id]).toEqual(["r1", "r1", "x"]);
      expect(calls).toBe(1);
    });

    test("a multi-paragraph delegated scope does not split a block", async () => {
      writeFileSync(
        join(root, "sources", "wiki.yaml"),
        "id: wiki\ntype: delegated\nvia: notion\nscope: |\n  First.\n\n  Second.\n\n  Third.\n",
      );
      expect(await cli("cite", "docs:a.md#L1", "wiki:design-page", "more:b.md#L1")).toBe(0);
      const blocks = stdout().split("\n\n");
      expect(blocks).toHaveLength(3);
      expect(blocks.map((b) => b.split("\n")[1])).toEqual([
        "canonical_source: docs:a.md#L1",
        "canonical_source: wiki:design-page",
        "canonical_source: more:b.md#L1",
      ]);
    });

    test("a bad target anywhere refuses them all before any is cited", async () => {
      expect(await cli("cite", "docs:a.md#L2", "nope:a.md")).toBe(2);
      expect(stderr()).toContain('Unknown source "nope"');
      expect(await cli("cite", "docs:a.md#L2", "a.md")).toBe(2);
      expect(output).toEqual([]);
    });
  });

  test("--format refuses a value it does not know, or one --json contradicts", async () => {
    expect(await cli("cite", "docs:a.md#L2", "--format", "yaml")).toBe(2);
    expect(stderr()).toContain('--format takes text, footnote or json, not "yaml"');
    errors = [];
    expect(await cli("cite", "docs:a.md#L2", "--format")).toBe(2);
    expect(stderr()).toContain("--format takes");
    errors = [];
    expect(await cli("cite", "docs:a.md#L2", "--json", "--format", "footnote")).toBe(2);
    expect(stderr()).toContain("--json and --format footnote");
    errors = [];
    // The first value would otherwise be read as a target.
    expect(await cli("cite", "docs:a.md#L2", "--format", "text", "--format=footnote")).toBe(2);
    expect(stderr()).toContain("--format is given more than once");
    expect(output).toEqual([]);
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

  test("reports the runtime's SQLite, which reindex and search need FTS5 from", async () => {
    await cli("init");
    output = [];
    await cli("doctor");
    expect(stdout()).toMatch(/\nruntime\n {2}ok: (node|bun) \S+, SQLite with FTS5\n/);
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

  test("an fs source whose snapshots cannot persist says why", async () => {
    await cli("init");
    rmSync(join(root, "sources", "example.yaml"), { force: true });
    mkdirSync(join(root, "sources", "docs"), { recursive: true });
    writeFileSync(join(root, "sources", "docs.yaml"), "id: docs\ntype: fs\nroot: sources/docs\n");
    const elsewhere = mkdtempSync(join(tmpdir(), "accreta-elsewhere-"));
    mkdirSync(join(root, ".accreta"), { recursive: true });
    symlinkSync(elsewhere, join(root, ".accreta", "fs-snapshots"));
    output = [];

    try {
      await cli("doctor");
      expect(stdout()).toContain("snapshots cannot persist:");
      expect(stdout()).toContain("fs-snapshots is a symlink");
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  test.skipIf(process.getuid === undefined)(
    "an index in a directory anyone can write, without the sticky bit, is named",
    async () => {
      await cli("init");
      rmSync(join(root, "sources", "example.yaml"), { force: true });
      mkdirSync(join(root, "sources", "docs"), { recursive: true });
      writeFileSync(join(root, "sources", "docs.yaml"), "id: docs\ntype: fs\nroot: sources/docs\n");
      const open = mkdtempSync(join(tmpdir(), "accreta-open-"));
      chmodSync(open, 0o777);
      process.env.ACCRETA_INDEX_PATH = join(open, "index.sqlite");
      output = [];

      try {
        await cli("doctor");
        expect(stdout()).toContain("snapshots cannot persist:");
        expect(stdout()).toContain("is world-writable without the sticky bit");
      } finally {
        delete process.env.ACCRETA_INDEX_PATH;
        rmSync(open, { recursive: true, force: true });
      }
    },
  );

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

  test("a provenance format that names no revision is flagged once", async () => {
    await cli("init");
    rmSync(join(root, "sources", "example.yaml"), { force: true });
    writeFileSync(
      join(root, "accreta.config.yaml"),
      'knowledge_base: knowledge\nprovenance:\n  format: "{source} · {path}#{locator}"\n',
      "utf-8",
    );
    output = [];

    await cli("doctor");
    expect(stdout().match(/has no \{rev\}/g)).toHaveLength(1);
    expect(stdout()).toContain("accreta cite");
    expect(stdout()).toContain("can read as prose");
  });

  test("the default provenance format is not flagged for its revision", async () => {
    await cli("init");
    output = [];

    await cli("doctor");
    expect(stdout()).not.toContain("unpinned:");
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

  test("two declarations sharing an id are both named, and neither wins", async () => {
    await cli("init");
    rmSync(join(root, "sources", "example.yaml"), { force: true });
    mkdirSync(join(root, "sources", "docs"), { recursive: true });
    for (const name of ["a.yaml", "b.yaml"]) {
      writeFileSync(join(root, "sources", name), "id: docs\ntype: fs\nroot: sources/docs\n");
    }
    const [a, b] = ["a.yaml", "b.yaml"].map((name) => join("sources", name));
    output = [];

    expect(await cli("doctor")).toBe(1);
    expect(stdout()).toContain(`docs — fs — ${a}`);
    expect(stdout()).toContain(`docs — fs — ${b}`);
    expect(stdout()).toContain(`id \`docs\` is also declared in ${b}`);
    expect(stdout()).toContain(`id \`docs\` is also declared in ${a}`);

    // The checks already fail here; doctor must not be the one command that passes.
    await cli("reindex");
    for (const command of ["lint", "drift"]) {
      const result = spawnCli({}, command);
      expect(result.code).toBe(1);
      expect(result.out).toContain(`id \`docs\` is also declared in ${b}`);
      expect(result.out).toContain(`id \`docs\` is also declared in ${a}`);
    }
  });

  test("a declaration missing only its type still claims its id", async () => {
    await cli("init");
    rmSync(join(root, "sources", "example.yaml"), { force: true });
    mkdirSync(join(root, "sources", "docs"), { recursive: true });
    writeFileSync(join(root, "sources", "a.yaml"), "id: docs\ntype: fs\nroot: sources/docs\n");
    writeFileSync(join(root, "sources", "b.yaml"), "id: docs\n");
    const [a, b] = ["a.yaml", "b.yaml"].map((name) => join("sources", name));
    output = [];

    expect(await cli("doctor")).toBe(1);
    expect(stdout()).toContain("needs a non-empty `type`");
    expect(stdout()).toContain(`id \`docs\` is also declared in ${b}`);
    expect(stdout()).toContain(`id \`docs\` is also declared in ${a}`);

    await cli("reindex");
    const lint = spawnCli({}, "lint");
    expect(lint.code).toBe(1);
    expect(lint.out).toContain(`id \`docs\` is also declared in ${b}`);
    expect(lint.out).toContain(`id \`docs\` is also declared in ${a}`);
  });
});
