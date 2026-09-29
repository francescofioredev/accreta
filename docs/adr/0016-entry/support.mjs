// No import path from here to node:sqlite: this has to load where node:sqlite does not.
export const UNSUPPORTED =
  "accreta needs SQLite with FTS5: Node ^22.16.0 || >=24, or Bun >=1.4.0 (bunx --bun accreta).";

let filtered = 0;
export const filteredWarnings = () => filtered;

const emitWarning = process.emitWarning;
process.emitWarning = (warning, ...rest) => {
  const message = typeof warning === "string" ? warning : warning?.message;
  if (message?.startsWith("SQLite is an experimental feature")) return void filtered++;
  return emitWarning.call(process, warning, ...rest);
};
