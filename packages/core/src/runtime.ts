// Imports nothing on purpose: a bin loads this where node:sqlite may not exist (ADR-0016).

export const UNSUPPORTED_RUNTIME =
  "accreta needs SQLite with FTS5: Node ^22.16.0 || >=24, or Bun >=1.4.0 (bunx --bun accreta).";

/** A program that has been loaded and can be run for its exit code. */
export type Program = () => Promise<number>;

/** Filter the SQLite warning, then load the program: Node 22 warns as node:sqlite is linked. */
export async function launch(load: () => Promise<Program>): Promise<void> {
  filterSqliteWarning();
  let program: Program;
  try {
    program = await load();
  } catch (error) {
    if (!isMissingBuiltin(error)) throw error;
    console.error(UNSUPPORTED_RUNTIME);
    process.exit(1);
  }
  process.exitCode = await program();
}

function filterSqliteWarning(): void {
  const emitWarning = process.emitWarning;
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    const message = typeof warning === "string" ? warning : warning?.message;
    if (message?.startsWith("SQLite is an experimental feature")) return;
    return (emitWarning as (...args: unknown[]) => void).call(process, warning, ...rest);
  }) as typeof process.emitWarning;
}

/** Node before 22.13 says ERR_UNKNOWN_BUILTIN_MODULE; Bun before 1.4 says it in the message. */
function isMissingBuiltin(error: unknown): boolean {
  const { code, message } = (error ?? {}) as { code?: unknown; message?: unknown };
  return (
    code === "ERR_UNKNOWN_BUILTIN_MODULE" ||
    (typeof message === "string" && /No such built-in module/.test(message))
  );
}
