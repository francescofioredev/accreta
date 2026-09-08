import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UnknownRevisionError } from "@accreta/core";
import { FsSource } from "../src/index.ts";

let root = "";

function write(relativePath: string, contents: string, mtimeSeconds?: number): void {
  const full = join(root, relativePath);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, contents, "utf-8");
  if (mtimeSeconds !== undefined) utimesSync(full, mtimeSeconds, mtimeSeconds);
}

function source() {
  return new FsSource({
    id: "docs",
    root,
    citationFormat: "{source} @ {rev} · {path}#{locator}",
  });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "accreta-fs-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("FsSource", () => {
  test("a revision is stable while nothing changes", async () => {
    write("a.md", "one", 1000);
    const fs = source();
    expect(await fs.revision()).toBe(await fs.revision());
  });

  test("a revision changes when a file is modified", async () => {
    write("a.md", "one", 1000);
    const fs = source();
    const before = await fs.revision();

    write("a.md", "two", 2000);
    expect(await fs.revision()).not.toBe(before);
  });

  test("a revision changes when a file is added, and returns when it is removed", async () => {
    write("a.md", "one", 1000);
    const fs = source();
    const before = await fs.revision();

    write("b.md", "two", 1000);
    expect(await fs.revision()).not.toBe(before);

    rmSync(join(root, "b.md"));
    expect(await fs.revision()).toBe(before);
  });

  test("changedSince names the files that moved", async () => {
    write("a.md", "one", 1000);
    write("b.md", "two", 1000);
    const fs = source();
    const first = await fs.revision();

    write("b.md", "changed", 2000);
    expect(await fs.changedSince(first)).toEqual(["b.md"]);
  });

  test("changedSince reports additions and deletions", async () => {
    write("a.md", "one", 1000);
    const fs = source();
    const first = await fs.revision();

    write("b.md", "new", 1000);
    rmSync(join(root, "a.md"));
    expect(await fs.changedSince(first)).toEqual(["a.md", "b.md"]);
  });

  test("an unknown revision is reported rather than answered as 'nothing changed'", async () => {
    write("a.md", "one", 1000);
    const fs = source();
    expect(fs.changedSince("deadbeef")).rejects.toThrow(UnknownRevisionError);
  });

  test("locate finds a path inside the root", async () => {
    write("docs/a.md", "hello", 1000);
    expect(await source().locate("docs/a.md")).toEqual({ verdict: "found" });
  });

  test("locate bounds a line range against the file", async () => {
    write("docs/a.md", "one\ntwo\nthree", 1000);
    expect(await source().locate("docs/a.md", "L2-L3")).toEqual({ verdict: "found" });

    const past = await source().locate("docs/a.md", "L2-L9");
    expect(past.verdict).toBe("missing");
    expect(past).toMatchObject({ part: "locator" });
  });

  test("locate refuses a locator this source cannot address by", async () => {
    write("docs/a.md", "hello", 1000);
    // A file is addressed by line. A block id is not a range this source has
    // any way to check, and saying "found" would be an invention.
    expect(await source().locate("docs/a.md", "block-a1b2c3")).toMatchObject({
      verdict: "missing",
      part: "locator",
    });
  });

  test("hidden directories and node_modules are not part of the source", async () => {
    write("a.md", "one", 1000);
    const fs = source();
    const before = await fs.revision();

    write("node_modules/pkg/index.js", "junk", 1000);
    write(".git/config", "junk", 1000);
    expect(await fs.revision()).toBe(before);
  });

  test("an extension filter narrows what counts as part of the source", async () => {
    write("a.md", "one", 1000);
    write("b.txt", "two", 1000);
    const markdown = new FsSource({
      id: "docs",
      root,
      citationFormat: "{source} @ {rev} · {path}",
      extensions: [".md"],
    });
    const before = await markdown.revision();

    write("b.txt", "changed", 2000);
    expect(await markdown.revision()).toBe(before);
  });

  test("a citation renders the configured format", () => {
    expect(source().citation("chapter-07.md", "L142-L158")).toContain("chapter-07.md#L142-L158");
  });

  test("a citation without a locator drops the locator decoration", () => {
    const cite = source().citation("chapter-07.md");
    expect(cite).not.toContain("{locator}");
    expect(cite).not.toContain("undefined");
  });

  test("a citation names the pinned revision, not the tree's current hash", async () => {
    const fs = source();
    const verifiedAt = await fs.revision();
    fs.pinRevision(verifiedAt);

    write("chapter-07.md", "rewritten after the claim was checked", 3000);
    expect(await fs.revision()).not.toBe(verifiedAt);

    expect(fs.citation("chapter-07.md", "L142-L158")).toContain(verifiedAt);
  });
});
