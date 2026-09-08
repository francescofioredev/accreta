import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRegistry, loadSources, readDeclarations } from "../src/index.ts";

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

const ctx = () => ({ root, citationFormat: "{source} @ {rev} · {path}#{locator}" });

describe("loadSources", () => {
  test("every declaration in sources/ becomes an adapter, keyed by id", () => {
    writeSource("docs.yaml", "id: docs\ntype: fs\nroot: corpus\n");
    writeSource("repo.yml", "id: repo\ntype: git\nroot: .\n");

    const sources = loadSources(ctx());
    expect([...sources.keys()].toSorted()).toEqual(["docs", "repo"]);
    expect(sources.get("docs")?.id).toBe("docs");
  });

  test("a workspace with no sources/ directory declares nothing", () => {
    rmSync(join(root, "sources"), { recursive: true });
    expect(loadSources(ctx()).size).toBe(0);
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

  test("an unknown type names the types this build does have", () => {
    writeSource("x.yaml", "id: x\ntype: notion\n");
    expect(() => loadSources(ctx())).toThrow(/Unknown source type "notion"/);
  });

  test("files that are not YAML are ignored", () => {
    writeSource("docs.yaml", "id: docs\ntype: fs\nroot: corpus\n");
    writeSource("README.md", "not a declaration");
    expect(loadSources(ctx()).size).toBe(1);
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

    const docs = loadSources(ctx()).get("docs")!;
    expect(docs.locate("chapter.md", "L1")).resolves.toEqual({ verdict: "found" });
  });
});
