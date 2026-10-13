import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Glob } from "bun";

const ROOT = join(import.meta.dir, "..");

// Node 22.16's node:sqlite throws "column index out of range" on `?1`; the unit suite runs on Bun, which accepts it.
test("no source file binds a numbered SQL parameter", () => {
  const found: string[] = [];
  for (const path of new Glob("packages/**/src/**/*.ts").scanSync(ROOT)) {
    if (path.includes("node_modules")) continue;
    readFileSync(join(ROOT, path), "utf-8")
      .split("\n")
      .forEach((line, i) => {
        if (/^\s*(\/\/|\*)/.test(line)) return;
        if (/\?\d/.test(line)) found.push(`${path}:${i + 1}: ${line.trim()}`);
      });
  }
  expect(found).toEqual([]);
});
