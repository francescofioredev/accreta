import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { snapshotDirFor } from "@accreta/adapter-fs";
import { isWorkingTree } from "@accreta/adapter-git";
import {
  buildRegistry,
  clashingIds,
  kindFor,
  loadSources,
  noSourceNamed,
  readDeclarationFiles,
  readDeclarations,
  stateDirFor,
  unloadedFindings,
} from "../src/index.ts";

let root = "";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "accreta-registry-"));
  mkdirSync(join(root, "sources"), { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function writeSource(name: string, yaml: string): void {
  writeFileSync(join(root, "sources", name), yaml, "utf-8");
}

const ctx = () => ({
  root,
  citationFormat: "{source} @ {rev} · {path}#{locator}",
  stateDir: join(root, ".accreta"),
});

describe("loadSources", () => {
  test("every declaration in sources/ becomes an adapter, keyed by id", () => {
    writeSource("docs.yaml", "id: docs\ntype: fs\nroot: corpus\n");
    writeSource("repo.yml", "id: repo\ntype: git\nroot: .\n");

    const { sources } = loadSources(ctx());
    expect([...sources.keys()].toSorted()).toEqual(["docs", "repo"]);
    expect(sources.get("docs")?.id).toBe("docs");
  });

  test("a workspace with no sources/ directory declares nothing", () => {
    rmSync(join(root, "sources"), { recursive: true });
    expect(loadSources(ctx()).sources.size).toBe(0);
  });

  test("two declarations sharing an id both go unloaded, each naming the other", () => {
    // An id names a source in every citation, so `docs:chapter.md` has to mean
    // one thing. This used to be silent, and silent differently in each
    // surface: the CLI built both and checked drift twice, the MCP server kept
    // whichever file sorted last. Keeping neither picks no winner and stops no other source.
    writeSource("a.yaml", "id: docs\ntype: fs\nroot: one\n");
    writeSource("b.yaml", "id: docs\ntype: fs\nroot: two\n");
    writeSource("repo.yaml", "id: repo\ntype: git\nroot: .\n");

    const { sources, unloaded } = loadSources(ctx());
    expect([...sources.keys()]).toEqual(["repo"]);
    expect(unloaded).toEqual([
      {
        file: join("sources", "a.yaml"),
        id: "docs",
        reason: expect.stringContaining(
          `id \`docs\` is also declared in ${join("sources", "b.yaml")}`,
        ),
      },
      {
        file: join("sources", "b.yaml"),
        id: "docs",
        reason: expect.stringContaining(
          `id \`docs\` is also declared in ${join("sources", "a.yaml")}`,
        ),
      },
    ]);
  });

  test("three declarations sharing an id each name the other two, and nothing absolute", () => {
    const files = ["a.yaml", "b.yaml", "c.yaml"].map((name) => join("sources", name));
    writeSource("a.yaml", "id: docs\ntype: fs\nroot: one\n");
    writeSource("b.yaml", "id: docs\ntype: fs\nroot: two\n");
    writeSource("c.yaml", "id: docs\ntype: notion\n");

    const { sources, unloaded } = loadSources(ctx());
    expect(sources.size).toBe(0);
    expect(unloaded.map((u) => u.file)).toEqual(files);
    for (const { file, reason } of unloaded) {
      for (const other of files.filter((f) => f !== file)) expect(reason).toContain(other);
      expect(reason).not.toContain(file);
      expect(reason).not.toContain(root);
      expect(reason).toEndWith("give each a distinct id or remove all but one");
    }
  });

  test("a declaration missing its type still claims its id, so the other does not win", () => {
    writeSource("a.yaml", "id: docs\ntype: fs\nroot: one\n");
    writeSource("b.yaml", "id: docs\nroot: two\n");
    writeSource("c.yaml", 'id: notes\ntype: ""\n');

    const { sources, unloaded } = loadSources(ctx());
    expect(sources.size).toBe(0);
    expect(unloaded).toEqual([
      {
        file: join("sources", "a.yaml"),
        id: "docs",
        reason: expect.stringContaining(`also declared in ${join("sources", "b.yaml")}`),
      },
      {
        file: join("sources", "b.yaml"),
        id: "docs",
        reason: expect.stringContaining(`also declared in ${join("sources", "a.yaml")}`),
      },
      { file: join("sources", "c.yaml"), id: "notes", reason: expect.stringContaining("`type`") },
    ]);
  });

  test("an unknown type is reported against its file, naming the types this build does have", () => {
    writeSource("x.yaml", "id: x\ntype: notion\n");
    const { unloaded } = loadSources(ctx());
    expect(unloaded).toHaveLength(1);
    expect(unloaded[0]?.file).toBe(join("sources", "x.yaml"));
    expect(unloaded[0]?.reason).toMatch(/Unknown source type "notion".*delegated, fs, git/);
  });

  test("a half-declared delegated source is reported, and the other sources still load", () => {
    writeSource("docs.yaml", "id: docs\ntype: fs\nroot: corpus\n");
    writeSource("design.yaml", "id: design\ntype: delegated\nvia: notion\nscope: |\n");

    const { sources, unloaded } = loadSources(ctx());
    expect([...sources.keys()]).toEqual(["docs"]);
    expect(unloaded).toEqual([
      {
        file: join("sources", "design.yaml"),
        id: "design",
        reason: expect.stringContaining("`scope`"),
      },
    ]);
  });

  test("git paths written from the repository top go unloaded, naming the entry they meant", async () => {
    const git = (...args: string[]) =>
      expect(spawnSync("git", args, { cwd: root, stdio: "ignore" }).status).toBe(0);
    git("init", "-q", "-b", "main");
    mkdirSync(join(root, "sub", "docs"), { recursive: true });
    writeFileSync(join(root, "sub", "docs", "a.md"), "one\n", "utf-8");
    git("add", "-A");
    git(
      "-c",
      "user.email=t@example.com",
      "-c",
      "user.name=T",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-q",
      "-m",
      "first",
    );
    writeSource("top.yaml", "id: top\ntype: git\nroot: sub\npaths: [sub/docs]\n");
    writeSource("fixed.yaml", "id: fixed\ntype: git\nroot: sub\npaths: [docs]\n");

    const refusal =
      '`paths` entry "sub/docs" (did you mean "docs"?) matches no tracked file. ' +
      "`paths` are relative to `root`, not to the repository top.";
    const { sources, unloaded } = loadSources(ctx());
    expect([...sources.keys()]).toEqual(["fixed"]);
    expect(unloaded).toEqual([
      { file: join("sources", "top.yaml"), id: "top", reason: `Source "top": ${refusal}` },
    ]);

    // doctor and `source add` must not pass what drift refuses.
    const [fixed, top] = readDeclarations(root);
    expect(await kindFor("git")!.preflight(top!, ctx())).toEqual({
      reachable: "no",
      detail: refusal,
    });
    expect((await kindFor("git")!.preflight(fixed!, ctx())).reachable).toBe("yes");
  });

  test("the shipped climate example still loads both of its git sources", async () => {
    const example = join(import.meta.dir, "..", "..", "..", "..", "examples", "climate");
    // Outside a checkout the paths check is skipped, and this would pass without testing it.
    expect(await isWorkingTree(example)).toBe(true);
    const { sources, unloaded } = loadSources({ ...ctx(), root: example });
    expect(unloaded).toEqual([]);
    expect([...sources.keys()].toSorted()).toEqual(["ipcc-ar6-wg1", "noaa-gml"]);
  });

  test("a git paths entry that is empty, escapes the root, or is no string goes unloaded", () => {
    writeSource("docs.yaml", "id: docs\ntype: fs\nroot: corpus\n");
    writeSource("empty.yaml", 'id: empty\ntype: git\nroot: .\npaths: [""]\n');
    writeSource("up.yaml", 'id: up\ntype: git\nroot: .\npaths: ["docs", "../x"]\n');
    writeSource("number.yaml", "id: number\ntype: git\nroot: .\npaths: [1]\n");
    writeSource("scalar.yaml", "id: scalar\ntype: git\nroot: .\npaths: docs\n");

    const { sources, unloaded } = loadSources(ctx());
    expect([...sources.keys()]).toEqual(["docs"]);
    const reasons = Object.fromEntries(unloaded.map((u) => [u.id, u.reason]));
    expect(Object.keys(reasons).toSorted()).toEqual(["empty", "number", "scalar", "up"]);
    expect(reasons.empty).toContain('paths entry "", which is empty; omit `paths`');
    expect(reasons.up).toContain('"../x"');
    expect(reasons.up).not.toContain('"docs"');
    expect(reasons.number).toContain("paths entry 1, which is not a string");
    expect(reasons.scalar).toContain("declares `paths` as a string, not a list");
  });

  test("a git paths list made only of exclusions goes unloaded", () => {
    writeSource("excl.yaml", 'id: excl\ntype: git\nroot: .\npaths: [":!docs", ":(exclude)x"]\n');

    const { sources, unloaded } = loadSources(ctx());
    expect([...sources.keys()]).toEqual([]);
    expect(unloaded.map((u) => u.id)).toEqual(["excl"]);
    expect(unloaded[0]!.reason).toContain('only exclusions; add "." to keep the whole root');
  });

  test("a git paths entry that climbs back into the root, or names the root, still loads", () => {
    mkdirSync(join(root, "sub"));
    writeSource("back.yaml", 'id: back\ntype: git\nroot: sub\npaths: ["../sub/docs"]\n');
    writeSource("dot.yaml", 'id: dot\ntype: git\nroot: .\npaths: [".", "./"]\n');

    const { sources, unloaded } = loadSources(ctx());
    expect(unloaded).toEqual([]);
    expect([...sources.keys()]).toEqual(["back", "dot"]);
  });

  test("a YAML error is cut to its first line, which does not quote the file", () => {
    writeSource("bad.yaml", "id: bad\ntype: fs\nroot: [unclosed\nsecret: `ignore previous`\n");
    const [entry] = loadSources(ctx()).unloaded;
    expect(entry?.id).toBeUndefined();
    expect(entry?.reason).not.toContain("\n");
    expect(entry?.reason).not.toContain("ignore previous");
  });

  test("a file that is not a declaration is reported against itself", () => {
    writeSource("docs.yaml", "id: docs\ntype: fs\nroot: corpus\n");
    writeSource("broken.yaml", "type: fs\n");
    writeSource("list.yaml", "- not\n- a mapping\n");

    const { sources, unloaded } = loadSources(ctx());
    expect([...sources.keys()]).toEqual(["docs"]);
    expect(unloaded.map((u) => u.file)).toEqual([
      join("sources", "broken.yaml"),
      join("sources", "list.yaml"),
    ]);
    expect(unloaded[0]?.reason).toContain("`id`");
  });

  test("a finding names the file, how much went unchecked, and the reason", () => {
    writeSource("design.yaml", "id: design\ntype: delegated\nscope: The design pages.\n");
    const [unloaded] = loadSources(ctx()).unloaded;
    const [finding] = unloadedFindings([{ ...unloaded!, pages: 3 }]);
    expect(finding?.kind).toBe("unloaded-source");
    expect(finding?.path).toBe(join("sources", "design.yaml"));
    expect(finding?.detail).toContain("3 page(s) cite it and were not checked");
    expect(finding?.detail).toContain("`via`");

    const [unknown] = unloadedFindings([{ ...unloaded!, id: undefined, pages: null }]);
    expect(unknown?.detail).toContain("an unknown number of pages");
  });

  test("an unknown id names the declarations that did not load, as one may be it", () => {
    const broken = [
      { file: "sources/wiki.yaml", reason: "not YAML" },
      { file: "sources/typo.yaml", id: "typo", reason: "unknown type" },
    ];
    expect(noSourceNamed("nope", ["docs"], broken)).toBe(
      'No source named "nope". Known: docs. Did not load: sources/wiki.yaml (no id), sources/typo.yaml.',
    );
    expect(noSourceNamed("nope", [], [])).toBe('No source named "nope". Known: none.');
  });

  test("the per-file reader returns a declaration or an error for each file", () => {
    writeSource("a.yaml", "id: a\ntype: fs\n");
    writeSource("b.yaml", "type: fs\n");
    const files = readDeclarationFiles(root);
    expect(files.map((f) => f.file)).toEqual([
      join("sources", "a.yaml"),
      join("sources", "b.yaml"),
    ]);
    expect("declaration" in files[0]! && files[0].declaration.id).toBe("a");
    expect("error" in files[1]! && files[1].error).toContain("`id`");
  });

  test("files that are not YAML are ignored", () => {
    writeSource("docs.yaml", "id: docs\ntype: fs\nroot: corpus\n");
    writeSource("README.md", "not a declaration");
    expect(loadSources(ctx()).sources.size).toBe(1);
  });
});

describe("readDeclarations", () => {
  test("declarations come back in a stable order, whatever the directory says", () => {
    writeSource("z.yaml", "id: z\ntype: fs\n");
    writeSource("a.yaml", "id: a\ntype: fs\n");
    expect(readDeclarations(root).map((d) => d.id)).toEqual(["a", "z"]);
  });

  test("options besides id and type are passed through untouched", () => {
    writeSource("docs.yaml", 'id: docs\ntype: fs\nroot: corpus\nextensions: [".md"]\n');
    expect(readDeclarations(root)[0]?.options).toEqual({ root: "corpus", extensions: [".md"] });
  });
});

describe("clashingIds", () => {
  test("names every file of a shared id, and only shared ids", () => {
    writeSource("a.yaml", "id: docs\ntype: fs\nroot: one\n");
    writeSource("b.yaml", "id: repo\ntype: git\nroot: .\n");
    writeSource("c.yaml", "id: docs\ntype: notion\n");
    writeSource("d.yaml", "type: fs\n");
    writeSource("e.yaml", "id: docs\ntype: fs\nroot: two\n");

    expect(clashingIds(readDeclarationFiles(root))).toEqual(
      new Map([["docs", ["a.yaml", "c.yaml", "e.yaml"].map((f) => join("sources", f))]]),
    );
  });

  test("no shared id, no clash", () => {
    writeSource("a.yaml", "id: docs\ntype: fs\nroot: one\n");
    writeSource("b.yaml", "id: repo\ntype: git\nroot: .\n");

    expect(clashingIds(readDeclarationFiles(root)).size).toBe(0);
  });
});

describe("buildRegistry", () => {
  test("both surfaces build the same adapters from the same declaration", () => {
    // The point of the package: the CLI and the MCP server used to carry this
    // registration and its option marshalling separately, so they were free to
    // disagree about what a declaration means.
    writeSource("docs.yaml", "id: docs\ntype: fs\nroot: corpus\n");
    const [declaration] = readDeclarations(root);

    const one = buildRegistry(ctx()).create(declaration!);
    const two = buildRegistry(ctx()).create(declaration!);
    expect(one.citation("chapter.md", "L1-L2")).toBe(two.citation("chapter.md", "L1-L2"));
  });

  test("a declaration's root is resolved against the workspace, not the process", () => {
    mkdirSync(join(root, "corpus"), { recursive: true });
    writeFileSync(join(root, "corpus", "chapter.md"), "one\ntwo\n", "utf-8");
    writeSource("docs.yaml", "id: docs\ntype: fs\nroot: corpus\n");

    const docs = loadSources(ctx()).sources.get("docs")!;
    expect(docs.locate("chapter.md", "L1")).resolves.toEqual({ verdict: "found" });
  });
});

describe("fs snapshots", () => {
  test("land beside the index, one directory per source", async () => {
    mkdirSync(join(root, "corpus"), { recursive: true });
    writeFileSync(join(root, "corpus", "chapter.md"), "one\n", "utf-8");
    writeSource("docs.yaml", "id: docs\ntype: fs\nroot: corpus\n");

    const revision = await loadSources(ctx()).sources.get("docs")!.revision();
    const file = join(snapshotDirFor(join(root, ".accreta"), "docs"), `${revision}.json`);
    expect(existsSync(file)).toBe(true);
  });

  test("follow the state directory the surface passes", async () => {
    mkdirSync(join(root, "corpus"), { recursive: true });
    writeFileSync(join(root, "corpus", "chapter.md"), "one\n", "utf-8");
    writeSource("docs.yaml", "id: docs\ntype: fs\nroot: corpus\n");
    const stateDir = join(root, "elsewhere");

    const revision = await loadSources({ ...ctx(), stateDir })
      .sources.get("docs")!
      .revision();
    expect(existsSync(join(snapshotDirFor(stateDir, "docs"), `${revision}.json`))).toBe(true);
  });

  test("any id persists, whatever a filesystem thinks of it as a name", async () => {
    mkdirSync(join(root, "corpus"), { recursive: true });
    writeFileSync(join(root, "corpus", "chapter.md"), "one\n", "utf-8");
    const stateDir = join(root, ".accreta");
    const base = join(stateDir, "fs-snapshots");

    for (const id of ["docs\uD800", "文".repeat(40), "..", "../../etc", "a/b"]) {
      const adapter = buildRegistry(ctx()).create({ id, type: "fs", options: { root: "corpus" } });
      const revision = await adapter.revision();
      expect(dirname(snapshotDirFor(stateDir, id))).toBe(base);
      expect(existsSync(join(snapshotDirFor(stateDir, id), `${revision}.json`))).toBe(true);
    }
  });
});

describe("stateDirFor", () => {
  test("the default is kept as written, so a committed symlink there is still caught", () => {
    const real = join(root, "real");
    mkdirSync(real);
    symlinkSync(real, join(root, ".accreta"));
    expect(stateDirFor(root, join(root, ".accreta", "index.sqlite"))).toBe(join(root, ".accreta"));
  });

  test("a directory the operator chose is resolved through its symlinks", () => {
    const real = join(root, "real");
    mkdirSync(real);
    symlinkSync(real, join(root, "link"));
    expect(stateDirFor(root, join(root, "link", "kb.sqlite"))).toBe(realpathSync(real));
  });
});

describe("fs preflight", () => {
  test("says when snapshots cannot persist, and why", async () => {
    mkdirSync(join(root, "corpus"));
    mkdirSync(join(root, ".accreta"));
    symlinkSync(join(root, "corpus"), join(root, ".accreta", "fs-snapshots"));
    const declaration = { id: "docs", type: "fs", options: { root: "corpus" } };

    const preflight = await kindFor("fs")!.preflight(declaration, ctx());
    expect(preflight.reachable).toBe("yes");
    expect(preflight.detail).toContain("snapshots cannot persist:");
    expect(preflight.detail).toContain("is a symlink");
  });
});

describe("git preflight", () => {
  test("names a paths entry the source would refuse to load", async () => {
    const declaration = { id: "repo", type: "git", options: { root: ".", paths: ["../x"] } };
    const preflight = await kindFor("git")!.preflight(declaration, ctx());
    expect(preflight.reachable).toBe("no");
    expect(preflight.detail).toContain('"../x"');
  });

  test("agrees with the loader on a paths entry that escapes a symlinked root", async () => {
    mkdirSync(join(root, "a", "sub"), { recursive: true });
    symlinkSync(join(root, "a", "sub"), join(root, "lnk"));
    writeSource("linked.yaml", 'id: linked\ntype: git\nroot: lnk\npaths: ["../lnk/docs"]\n');
    const declaration = {
      id: "linked",
      type: "git",
      options: { root: "lnk", paths: ["../lnk/docs"] },
    };

    const preflight = await kindFor("git")!.preflight(declaration, ctx());
    expect(preflight.reachable).toBe("no");
    expect(preflight.detail).toContain("outside the source root");
    expect(loadSources(ctx()).unloaded.map((u) => u.reason)).toEqual([
      expect.stringContaining("outside the source root"),
    ]);
  });

  test("reports git's refusal of a pathspec the loader cannot judge", async () => {
    const init = Bun.spawnSync(["git", "init", "-q"], { cwd: root });
    expect(init.exitCode).toBe(0);
    const declaration = {
      id: "repo",
      type: "git",
      options: { root: ".", paths: [":(bogus)docs"] },
    };
    const preflight = await kindFor("git")!.preflight(declaration, ctx());
    expect(preflight.reachable).toBe("no");
    expect(preflight.detail).toContain("bogus");
  });
});
