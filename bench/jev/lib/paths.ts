import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const JEV_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
export const DATA = join(JEV_DIR, "data");
export const RESULTS = join(JEV_DIR, "results");
// Fetched third-party data and the call cache: reproducible, never committed.
export const EXTERNAL = join(JEV_DIR, ".external");
export const CACHE = join(JEV_DIR, ".cache");
export const REPO = join(JEV_DIR, "..", "..");
export const DOCS = join(REPO, "docs", "research", "2026-09-jev");
