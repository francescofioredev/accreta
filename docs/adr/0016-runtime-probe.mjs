// Records where Node and Bun differ in ways the seam and the bins must absorb (ADR-0016).
// Run with `node` or `bun` on this file. It reports outcomes; it asserts nothing.
import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const isBun = typeof globalThis.Bun !== "undefined";
const runtime = isBun ? `bun ${globalThis.Bun.version}` : `node ${process.version}`;

// The seam's loading pattern: filter the one warning, then load the driver synchronously.
let filtered = 0;
const emitWarning = process.emitWarning;
process.emitWarning = (warning, ...rest) => {
  const message = typeof warning === "string" ? warning : warning?.message;
  if (/^SQLite is an experimental feature/.test(message ?? "")) return void filtered++;
  return emitWarning.call(process, warning, ...rest);
};
const require = createRequire(import.meta.url);
const driver = isBun ? "bun:sqlite" : "node:sqlite";
const Database = isBun ? require(driver).Database : require(driver).DatabaseSync;
const open = (path, opts) => new Database(path, opts);

const dir = mkdtempSync(join(tmpdir(), "accreta-0016-rt-"));
const rows = [];

function probe(name, fn) {
  let outcome;
  try {
    outcome = `ok: ${JSON.stringify(fn())}`;
  } catch (error) {
    outcome = `throws: ${String(error?.message ?? error).split("\n")[0]}`;
  }
  rows.push([name, outcome]);
}

async function probeAsync(name, fn) {
  let outcome;
  try {
    outcome = `ok: ${JSON.stringify(await fn())}`;
  } catch (error) {
    outcome = `throws: ${String(error?.code ?? error?.message ?? error)}`;
  }
  rows.push([name, outcome]);
}

probe("import.meta.main in the entry module", () => import.meta.main);
probe("experimental warnings filtered while loading", () => filtered);

const readWrite = isBun ? { create: true } : {};
const mem = open(":memory:", readWrite);
mem.exec("CREATE TABLE t (a, b)");
probe("bind undefined", () => mem.prepare("INSERT INTO t (a) VALUES (?)").run(undefined).changes);
probe("bind true", () => mem.prepare("INSERT INTO t (a) VALUES (?)").run(true).changes);
probe(
  "unknown named key",
  () => mem.prepare("INSERT INTO t (a) VALUES ($a)").run({ $a: 1, $nope: 2 }).changes,
);
probe("double-quoted string literal", () => mem.prepare(`SELECT "text" AS v`).get());
probe("INTEGER above 2^53", () => String(mem.prepare("SELECT 9007199254740993 AS n").get().n));
const stmt = mem.prepare("SELECT 1 AS one");
mem.close();
probe("statement used after close()", () => stmt.all());

// Each runtime's spelling of read-only, passed to both: a wrong spelling must not open read-write.
// Numbered files: on a case-insensitive filesystem the two spellings would name one file.
for (const [i, spelling] of ["readonly", "readOnly"].entries()) {
  const path = join(dir, `ro-${i}.sqlite`);
  const rw = open(path, readWrite);
  rw.exec("CREATE TABLE t (a)");
  rw.close();
  probe(`write through { ${spelling}: true }`, () => {
    const db = open(path, { [spelling]: true });
    try {
      db.exec("INSERT INTO t VALUES (1)");
      return "write accepted";
    } finally {
      db.close();
    }
  });
}

// Default maxBuffer is 1 MiB; a large `git diff` goes past it.
const big = [process.execPath, ["-e", "process.stdout.write('x'.repeat(2 * 1024 * 1024))"]];
probe("execFileSync, 2 MiB of stdout, default maxBuffer", () => execFileSync(...big).length);
await probeAsync(
  "execFile (async), 2 MiB of stdout, maxBuffer 64 MiB",
  async () => (await promisify(execFile)(...big, { maxBuffer: 64 * 1024 * 1024 })).stdout.length,
);

rmSync(dir, { recursive: true, force: true });

console.log(`${runtime} (${driver})`);
for (const [name, outcome] of rows) console.log(`  ${name.padEnd(52)} ${outcome}`);
