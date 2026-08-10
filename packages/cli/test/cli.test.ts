import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/main.ts";
import type { CommandContext } from "../src/commands.ts";

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
    expect(await cli("search")).toBe(1);
    expect(stderr()).toContain("Usage");
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

describe("accreta help", () => {
  test("no arguments prints usage", async () => {
    expect(await cli()).toBe(0);
    expect(stdout()).toContain("Usage: accreta");
  });

  test("an unknown command is an error with usage", async () => {
    expect(await cli("frobnicate")).toBe(1);
    expect(stderr()).toContain("Unknown command");
  });
});
