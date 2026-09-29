// The bin entry shape ADR-0016 decides: filter first, then load the program dynamically.
import { UNSUPPORTED } from "./support.mjs";

let program;
try {
  program = await import("./program.mjs");
} catch (error) {
  const missing =
    error?.code === "ERR_UNKNOWN_BUILTIN_MODULE" || /No such built-in module/.test(error?.message);
  if (!missing) throw error;
  console.error(UNSUPPORTED);
  process.exit(1);
}
process.exitCode = program.run();
