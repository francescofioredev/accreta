#!/usr/bin/env bun
/**
 * Fetch the RFC Editor's errata feed and index, and any RFC texts the builders ask for.
 * The files stay in .external/; data/snapshots.json records what was fetched and its sha256,
 * so a later run can tell whether upstream moved.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sha256 } from "../lib/cache.ts";
import { DATA, EXTERNAL } from "../lib/paths.ts";

const DIR = join(EXTERNAL, "rfc");
const SNAPSHOTS = join(DATA, "snapshots.json");

export const FEEDS = {
  errata: "https://www.rfc-editor.org/api/v1/errata.json",
  index: "https://www.rfc-editor.org/rfc-index.xml",
} as const;

type Snapshots = Record<string, { url: string; fetched: string; sha256: string; bytes: number }>;

const readSnapshots = (): Snapshots =>
  existsSync(SNAPSHOTS) ? JSON.parse(readFileSync(SNAPSHOTS, "utf8")) : {};

/** Download once; afterwards verify against the recorded hash and refuse silently moved data. */
export async function fetchPinned(name: string, url: string): Promise<string> {
  mkdirSync(DIR, { recursive: true });
  const file = join(DIR, name);
  const snapshots = readSnapshots();
  if (!existsSync(file)) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    writeFileSync(file, new Uint8Array(await res.arrayBuffer()));
  }
  const bytes = readFileSync(file);
  const hash = sha256(bytes);
  const known = snapshots[name];
  if (known && known.sha256 !== hash) {
    throw new Error(
      `${name}: sha256 ${hash} differs from the snapshot recorded on ${known.fetched}. Upstream moved.`,
    );
  }
  if (!known) {
    snapshots[name] = {
      url,
      fetched: new Date().toISOString().slice(0, 10),
      sha256: hash,
      bytes: bytes.length,
    };
    writeFileSync(SNAPSHOTS, JSON.stringify(snapshots, null, 2) + "\n");
  }
  return file;
}

export const rfcText = (n: number) =>
  fetchPinned(`rfc${n}.txt`, `https://www.rfc-editor.org/rfc/rfc${n}.txt`);

if (import.meta.main) {
  for (const [name, url] of Object.entries(FEEDS))
    console.log(await fetchPinned(`${name}.${url.split(".").pop()}`, url));
}
