import { afterEach, beforeEach, describe, expect, test } from "bun:test";
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
import {
  buildRegistry,
  kindFor,
  loadSources,
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

  test("two declarations sharing an id are refused rather than resolved", () => {
    // An id names a source in every citation, so `docs:chapter.md` has to mean
    // one thing. This used to be silent, and silent differently in each
    // surface: the CLI built both and checked drift twice, the MCP server kept
    // whichever file sorted last.
    writeSource("a.yaml", "id: docs\ntype: fs\nroot: one\n");
    writeSource("b.yaml", "id: docs\ntype: fs\nroot: two\n");

    expect(() => loadSources(ctx())).toThrow(/declared with id "docs"/);
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
