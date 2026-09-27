import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CACHE } from "./paths.ts";

export const sha256 = (s: string | Uint8Array) => createHash("sha256").update(s).digest("hex");

export async function cached<T>(
  namespace: string,
  key: unknown,
  compute: () => Promise<T>,
  keep: (value: T) => boolean = () => true,
): Promise<T> {
  const dir = join(CACHE, namespace);
  const file = join(dir, `${sha256(JSON.stringify(key))}.json`);
  if (existsSync(file)) return { ...JSON.parse(readFileSync(file, "utf8")), cached: true };
  const value = await compute();
  if (!keep(value)) return { ...value, cached: false };
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, JSON.stringify(value));
  return { ...value, cached: false };
}
