// Stands in for the CLI: imports node:sqlite statically, as db.ts will.
import { DatabaseSync } from "node:sqlite";
import { filteredWarnings, UNSUPPORTED } from "./support.mjs";

export function run() {
  const runtime = typeof Bun !== "undefined" ? `bun ${Bun.version}` : `node ${process.version}`;
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("CREATE VIRTUAL TABLE t USING fts5(x)");
  } catch {
    console.error(UNSUPPORTED);
    return 1;
  } finally {
    db.close();
  }
  console.log(`${runtime}: node:sqlite with FTS5, warnings filtered: ${filteredWarnings()}`);
  return 0;
}
