import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executable, findOnPath } from "../src/spawn.ts";

let base = "";

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "accreta-path-"));
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

function dir(name: string, files: Record<string, number> = {}): string {
  const full = join(base, name);
  mkdirSync(full, { recursive: true });
  for (const [file, mode] of Object.entries(files)) writeFileSync(join(full, file), "", { mode });
  return full;
}

describe("findOnPath", () => {
  test("takes the first absolute entry that holds an executable", () => {
    const [empty, first, second] = [
      dir("empty"),
      dir("a", { git: 0o755 }),
      dir("b", { git: 0o755 }),
    ];
    expect(findOnPath("git", { PATH: [empty, first, second].join(":") }, "linux")).toBe(
      join(first, "git"),
    );
  });

  test("never looks in the cwd: empty, relative and dot entries are skipped", () => {
    const real = dir("real", { git: 0o755 });
    dir("rel", { git: 0o755 });
    writeFileSync(join(base, "git"), "", { mode: 0o755 });
    const cwd = process.cwd();
    process.chdir(base);
    try {
      const env = { PATH: ["", ".", "rel", real].join(":") };
      expect(findOnPath("git", env, "linux")).toBe(join(real, "git"));
    } finally {
      process.chdir(cwd);
    }
  });

  test("skips a file that is not executable, and a directory with the name", () => {
    const plain = dir("plain", { git: 0o644 });
    const folder = dir("folder");
    mkdirSync(join(folder, "git"));
    const real = dir("real", { git: 0o755 });
    expect(findOnPath("git", { PATH: [plain, folder, real].join(":") }, "darwin")).toBe(
      join(real, "git"),
    );
  });

  test("answers nothing when no entry has it", () => {
    expect(findOnPath("git", { PATH: dir("none") }, "linux")).toBeUndefined();
    expect(findOnPath("git", {}, "linux")).toBeUndefined();
  });

  test("on Windows takes only .COM or .EXE, reads Path in any case, and unquotes entries", () => {
    const bare = dir("bare", { git: 0o644 });
    // spawn refuses these without a shell, whatever PATHEXT says.
    const scripts = dir("scripts", { "git.CMD": 0o644, "git.BAT": 0o644 });
    const exe = dir("with space", { "git.EXE": 0o644 });
    const env = { Path: [bare, scripts, `"${exe}"`].join(";"), PATHEXT: ".CMD;.BAT;.EXE" };
    expect(findOnPath("git", env, "win32")).toBe(join(exe, "git.EXE"));
  });
});

describe("executable", () => {
  const saved = process.env.PATH;

  afterEach(() => {
    process.env.PATH = saved;
  });

  test("resolves again when PATH changes", () => {
    const a = dir("a", { tool: 0o755 });
    const b = dir("b", { tool: 0o755 });
    process.env.PATH = a;
    expect(executable("tool")).toBe(join(a, "tool"));
    process.env.PATH = b;
    expect(executable("tool")).toBe(join(b, "tool"));
  });

  test("a miss is not remembered, so a git installed later is found", () => {
    const a = dir("a");
    process.env.PATH = a;
    expect(executable("tool")).toBeUndefined();
    writeFileSync(join(a, "tool"), "", { mode: 0o755 });
    expect(executable("tool")).toBe(join(a, "tool"));
  });
});

/** Whether `file` stops growing within 5 s; kill(pid, 0) would also answer yes for a zombie. */
async function stopsBeating(file: string): Promise<boolean> {
  const size = () => (existsSync(file) ? statSync(file).size : 0);
  const deadline = Date.now() + 5_000;
  let last = size();
  while (Date.now() < deadline) {
    await Bun.sleep(400);
    if (size() === last) return true;
    last = size();
  }
  return false;
}

describe("run", () => {
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    test(`${signal} to the host takes the child's process group with it`, async () => {
      const heartbeat = join(base, "beat");
      const script = join(base, "child.sh");
      writeFileSync(
        script,
        `echo $$ > "${heartbeat}.pid"\nwhile :; do echo . >> "${heartbeat}"; sleep 0.1; done\n`,
      );
      const code = `
          import { run } from ${JSON.stringify(join(import.meta.dir, "../src/spawn.ts"))};
          await run("/bin/sh", [${JSON.stringify(script)}], {
            cwd: ${JSON.stringify(base)}, env: process.env, timeoutMs: 60000, command: "sh",
          });`;
      const host = Bun.spawn([process.execPath, "-e", code], {
        stdout: "ignore",
        stderr: "ignore",
      });
      try {
        const deadline = Date.now() + 5_000;
        while (!existsSync(heartbeat) && Date.now() < deadline) await Bun.sleep(50);
        expect(existsSync(heartbeat)).toBe(true);

        host.kill(signal);
        await host.exited;
        expect(await stopsBeating(heartbeat)).toBe(true);
      } finally {
        host.kill("SIGKILL");
        try {
          process.kill(Number(readFileSync(`${heartbeat}.pid`, "utf-8")), "SIGKILL");
        } catch {
          // Already gone, as it should be.
        }
      }
    }, 15_000);
  }
});
