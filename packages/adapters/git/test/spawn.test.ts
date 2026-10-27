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
import { executable, findOnPath, treeKill } from "../src/spawn.ts";

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

describe("treeKill", () => {
  test("names taskkill under SystemRoot, read in any case, and the whole tree of the pid", () => {
    const expected = {
      file: "C:\\Windows\\System32\\taskkill.exe",
      args: ["/T", "/F", "/PID", "4242"],
    };
    expect(treeKill(4242, { SystemRoot: "C:\\Windows" })).toEqual(expected);
    expect(treeKill(4242, { SYSTEMROOT: "C:\\Windows\\" })).toEqual(expected);
    expect(treeKill(4242, { systemroot: "C:/Windows" })).toEqual(expected);
  });

  test("never searches PATH or the cwd", () => {
    const planted = dir("planted", { "taskkill.exe": 0o755 });
    const env = { Path: planted, SystemRoot: "D:\\Win" };
    expect(treeKill(1, env)?.file).toBe("D:\\Win\\System32\\taskkill.exe");
  });

  test("answers nothing without a SystemRoot rooted at a drive", () => {
    for (const root of ["", "Windows", ".\\Windows", "\\Windows", "C:Windows", "\\\\host\\share"]) {
      expect(treeKill(1, { SystemRoot: root })).toBeUndefined();
    }
    expect(treeKill(1, {})).toBeUndefined();
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

/** A host process that runs `prelude`, then a heartbeat child through `run()`, and gets `signal`. */
async function signalHost(signal: NodeJS.Signals, prelude = ""): Promise<{ beating: boolean }> {
  const heartbeat = join(base, "beat");
  const script = join(base, "child.sh");
  writeFileSync(
    script,
    `echo $$ > "${heartbeat}.pid"\nwhile :; do echo . >> "${heartbeat}"; sleep 0.1; done\n`,
  );
  const code = `
      import { run } from ${JSON.stringify(join(import.meta.dir, "../src/spawn.ts"))};
      ${prelude}
      await run("/bin/sh", [${JSON.stringify(script)}], {
        cwd: ${JSON.stringify(base)}, env: process.env, timeoutMs: 60000, command: "sh",
      });`;
  const host = Bun.spawn([process.execPath, "-e", code], { stdout: "ignore", stderr: "ignore" });
  try {
    const deadline = Date.now() + 5_000;
    while (!existsSync(heartbeat) && Date.now() < deadline) await Bun.sleep(50);
    expect(existsSync(heartbeat)).toBe(true);

    host.kill(signal);
    await host.exited;
    return { beating: !(await stopsBeating(heartbeat)) };
  } finally {
    host.kill("SIGKILL");
    try {
      process.kill(Number(readFileSync(`${heartbeat}.pid`, "utf-8")), "SIGKILL");
    } catch {
      // Already gone, as it should be.
    }
  }
}

describe("run", () => {
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    test(`${signal} to the host takes the child's process group with it`, async () => {
      expect(await signalHost(signal)).toEqual({ beating: false });
    }, 15_000);
  }

  test("the signal listeners are in place before git is spawned", async () => {
    // Patched before spawn.ts is imported, since its named import binds then.
    const code = `
      const cp = require("node:child_process");
      const spawn = cp.spawn;
      let listening = -1;
      cp.spawn = (...args) => { listening = process.listenerCount("SIGINT"); return spawn(...args); };
      const { run } = await import(${JSON.stringify(join(import.meta.dir, "../src/spawn.ts"))});
      const before = process.listenerCount("SIGINT");
      await run(process.execPath, ["-e", "0"], {
        cwd: ${JSON.stringify(base)}, env: process.env, timeoutMs: 10000, command: "probe",
      });
      console.log(JSON.stringify({ before, listening }));`;
    const host = Bun.spawn([process.execPath, "-e", code], { stdout: "pipe", stderr: "pipe" });
    const out = await new Response(host.stdout).text();
    expect(await host.exited).toBe(0);
    expect(JSON.parse(out)).toEqual({ before: 0, listening: 1 });
  }, 15_000);

  test("a host's own graceful shutdown on SIGINT still runs to the end", async () => {
    const cleaned = join(base, "cleaned");
    const prelude = `import { writeFileSync } from "node:fs";
      process.once("SIGINT", () => setTimeout(() => {
        writeFileSync(${JSON.stringify(cleaned)}, "");
        process.exit(0);
      }, 300));`;
    expect(await signalHost("SIGINT", prelude)).toEqual({ beating: false });
    expect(existsSync(cleaned)).toBe(true);
  }, 15_000);

  test("a spawn that throws leaves no signal listener behind", async () => {
    const code = `
      const cp = require("node:child_process");
      cp.spawn = () => { throw new Error("no spawn"); };
      const { run } = await import(${JSON.stringify(join(import.meta.dir, "../src/spawn.ts"))});
      const before = process.listenerCount("SIGINT");
      const failed = await run("git", [], {
        cwd: ${JSON.stringify(base)}, env: process.env, timeoutMs: 10000, command: "probe",
      }).then(() => false, () => true);
      console.log(JSON.stringify({ before, failed, after: process.listenerCount("SIGINT") }));`;
    const host = Bun.spawn([process.execPath, "-e", code], { stdout: "pipe", stderr: "pipe" });
    const out = await new Response(host.stdout).text();
    expect(await host.exited).toBe(0);
    expect(JSON.parse(out)).toEqual({ before: 0, failed: true, after: 0 });
  }, 15_000);
});
