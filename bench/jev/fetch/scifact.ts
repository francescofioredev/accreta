#!/usr/bin/env bun
/** Fetch SciFact (CC BY-NC 2.0) into .external/; it is never vendored. */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sha256 } from "../lib/cache.ts";
import { DATA, EXTERNAL } from "../lib/paths.ts";

export const SCIFACT_URL = "https://scifact.s3-us-west-2.amazonaws.com/release/latest/data.tar.gz";
export const SCIFACT_DIR = join(EXTERNAL, "scifact");

export async function fetchScifact(): Promise<string> {
  const tarball = join(SCIFACT_DIR, "data.tar.gz");
  mkdirSync(SCIFACT_DIR, { recursive: true });
  if (!existsSync(tarball)) {
    const res = await fetch(SCIFACT_URL);
    if (!res.ok) throw new Error(`${SCIFACT_URL}: HTTP ${res.status}`);
    writeFileSync(tarball, new Uint8Array(await res.arrayBuffer()));
  }
  const hash = sha256(readFileSync(tarball));
  const file = join(DATA, "snapshots.json");
  const snapshots = JSON.parse(readFileSync(file, "utf8"));
  const known = snapshots["scifact/data.tar.gz"];
  if (known && known.sha256 !== hash) throw new Error(`SciFact moved since ${known.fetched}`);
  if (!known) {
    snapshots["scifact/data.tar.gz"] = {
      url: SCIFACT_URL,
      fetched: new Date().toISOString().slice(0, 10),
      sha256: hash,
      bytes: readFileSync(tarball).length,
    };
    writeFileSync(file, JSON.stringify(snapshots, null, 2) + "\n");
  }
  if (!existsSync(join(SCIFACT_DIR, "data", "claims_dev.jsonl")))
    execFileSync("tar", ["-xzf", tarball, "-C", SCIFACT_DIR]);
  return join(SCIFACT_DIR, "data");
}

if (import.meta.main) console.log(await fetchScifact());
