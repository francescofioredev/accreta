// H1 and the page metrics, read with every git source at the pin.
// Usage: bun bench/eval/pages.ts --kb <dir> --at <rev>
import { parseArgs } from "node:util";
import { kbAt } from "./lib/accreta.ts";
import { measurePages } from "./lib/pages.ts";

if (import.meta.main) {
  const { values } = parseArgs({ options: { kb: { type: "string" }, at: { type: "string" } } });
  if (!values.kb || !values.at) {
    console.error("usage: pages.ts --kb <dir> --at <rev>");
    process.exit(2);
  }
  console.log(JSON.stringify(measurePages(kbAt(values.kb), values.at), null, 2));
}
