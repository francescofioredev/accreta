import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Does the published package actually work?
 *
 * Everything else in the suite runs against the repository, where the templates
 * and the schema are simply there. A user has a tarball, and a tarball only
 * contains what `files` and `prepack` put in it. The gap between those two
 * situations is invisible until someone installs the thing, and by then the
 * version is on npm and cannot be republished.
 *
 * So this test builds the tarballs, installs them somewhere the repository
 * cannot be reached, and drives the CLI from there.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** In dependency order: a dependent installed before its dependency is broken. */
const PUBLISHABLE = [
  "packages/core",
  "packages/adapters/fs",
  "packages/adapters/git",
  "packages/cli",
  "packages/mcp-server",
];

let staging = "";
let consumer = "";
let accreta = "";

/** `accreta-core-0.1.1.tgz` is `@accreta/core`; `accreta-0.1.1.tgz` is `accreta`. */
function nameOf(tarball: string): string {
  const stem = tarball.replace(/-\d+\.\d+\.\d+\.tgz$/, "");
  return stem === "accreta" ? stem : `@accreta/${stem.replace(/^accreta-/, "")}`;
}

beforeAll(() => {
  staging = mkdtempSync(join(tmpdir(), "accreta-staging-"));
  consumer = mkdtempSync(join(tmpdir(), "accreta-consumer-"));

  for (const pkg of PUBLISHABLE) {
    // `bun pm pack` runs prepack, which is what copies the templates in.
    const packed = Bun.spawnSync(["bun", "pm", "pack", "--destination", staging], {
      cwd: join(REPO_ROOT, pkg),
      stderr: "pipe",
    });
    if (packed.exitCode !== 0) {
      throw new Error(`packing ${pkg} failed:\n${packed.stderr.toString()}`);
    }
  }

  const tarballs = readdirSync(staging).filter((name) => name.endsWith(".tgz"));
  expect(tarballs).toHaveLength(PUBLISHABLE.length);

  // Every tarball depends on the others by version, and those versions are not
  // on the registry yet — the first publish is what puts them there. `overrides`
  // points those dependencies back at the local files, so the packed artifacts
  // satisfy each other and what gets exercised is still the packed layout.
  const specifiers = Object.fromEntries(tarballs.map((name) => [nameOf(name), `file:./${name}`]));
  writeFileSync(
    join(consumer, "package.json"),
    JSON.stringify({
      name: "consumer",
      version: "0.0.0",
      private: true,
      dependencies: specifiers,
      overrides: specifiers,
    }),
    "utf-8",
  );
  for (const name of tarballs) {
    cpSync(join(staging, name), join(consumer, name));
  }

  const install = Bun.spawnSync(["bun", "install"], { cwd: consumer, stderr: "pipe" });
  if (install.exitCode !== 0) {
    throw new Error(`installing the tarballs failed:\n${install.stderr.toString()}`);
  }

  accreta = join(consumer, "node_modules", ".bin", "accreta");
});

afterAll(() => {
  for (const dir of [staging, consumer]) {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

test("the CLI is installed under the name it publishes as", () => {
  expect(existsSync(accreta)).toBe(true);
});

test("an installed CLI carries its own constitution templates", () => {
  // The project directory is under tmpdir(), never inside the repository. Were
  // it inside, the resolver's repo-root fallback would find the real templates
  // and this test would pass against a package that ships none of them — which
  // is precisely the bug it exists to catch.
  const project = mkdtempSync(join(tmpdir(), "accreta-project-"));
  try {
    const init = Bun.spawnSync([accreta, "init", "--preset", "research"], {
      cwd: project,
      stderr: "pipe",
      stdout: "pipe",
    });
    expect(init.stderr.toString() + init.stdout.toString()).not.toContain("template not found");
    expect(init.exitCode).toBe(0);

    // Not merely that init exited zero: it writes the config before the
    // constitution, so a missing template still leaves a half-finished run.
    const agents = readFileSync(join(project, "AGENTS.md"), "utf-8");
    expect(agents).toContain("composed from: base.md + presets/research.md");
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("an installed core carries the schema its index is built from", () => {
  // schema.sql is the one non-TypeScript file in core/src. A `files` field
  // written as a *.ts glob would drop it and every reindex would fail here.
  const project = mkdtempSync(join(tmpdir(), "accreta-project-"));
  try {
    Bun.spawnSync([accreta, "init"], { cwd: project, stderr: "pipe", stdout: "pipe" });
    const reindex = Bun.spawnSync([accreta, "reindex"], {
      cwd: project,
      stderr: "pipe",
      stdout: "pipe",
    });
    expect(reindex.stderr.toString()).not.toContain("schema.sql");
    expect(reindex.exitCode).toBe(0);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("the published manifests name real versions, not workspace protocols", () => {
  // npm is what publishes, and unlike bun it does not rewrite `workspace:*` —
  // it copies the string into the tarball verbatim. A published package
  // carrying `workspace:*` cannot be installed by anyone, and npm does not
  // allow the version to be republished. So the protocol must never reach a
  // manifest in the first place.
  for (const pkg of PUBLISHABLE) {
    const manifest = JSON.parse(readFileSync(join(REPO_ROOT, pkg, "package.json"), "utf-8")) as {
      dependencies?: Record<string, string>;
    };

    for (const [name, range] of Object.entries(manifest.dependencies ?? {})) {
      expect(`${pkg} → ${name}: ${range}`).not.toContain("workspace:");
    }
  }
});
