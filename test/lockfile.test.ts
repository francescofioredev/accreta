import { expect, test } from "bun:test";
import { PUBLISHABLE, versionOf } from "../scripts/check-version.ts";

interface Lockfile {
  workspaces: Record<string, { version?: string; dependencies?: Record<string, string> }>;
}

async function lockfile(): Promise<Lockfile> {
  const text = await Bun.file(new URL("../bun.lock", import.meta.url)).text();
  // bun.lock is JSONC: trailing commas are legal in it and not in JSON.parse.
  return JSON.parse(text.replace(/,(\s*[}\]])/g, "$1")) as Lockfile;
}

/**
 * What `bun install --frozen-lockfile` does not check.
 *
 * The flag is documented in ci.yml as the guard against a stale lockfile, and
 * it is not one for workspace members: bun resolves them by path, so the
 * versions recorded beside them are informational and a lockfile naming 0.1.1
 * against manifests at 0.1.2 installs clean and exits 0. Measured on 1.3.13 by
 * skewing a throwaway workspace — the flag accepted a changed dependency range
 * too, and left the lockfile untouched.
 *
 * That drift is not cosmetic. `npm publish` copies a `workspace:*` through
 * untouched, so a package carrying one cannot be installed by anybody, and the
 * release flow leans on this same flag.
 */
test("the lockfile records the versions the manifests name", async () => {
  const { workspaces } = await lockfile();

  for (const pkg of PUBLISHABLE) {
    const entry = workspaces[pkg];
    expect(`${pkg}: present in bun.lock`).toBe(entry ? `${pkg}: present in bun.lock` : "missing");
    expect(`${pkg} @ ${entry!.version}`).toBe(`${pkg} @ ${versionOf(pkg)}`);
  }
});

test("no publishable package depends on a sibling by workspace protocol", async () => {
  const { workspaces } = await lockfile();

  for (const pkg of PUBLISHABLE) {
    for (const [name, range] of Object.entries(workspaces[pkg]?.dependencies ?? {})) {
      expect(`${pkg} → ${name}: ${range}`).not.toContain("workspace:");
    }
  }
});
