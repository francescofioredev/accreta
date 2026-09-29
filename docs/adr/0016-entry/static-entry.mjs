// The shape ADR-0016 rejects: a static import path to node:sqlite, filter on the line above.
import "./support.mjs";
import { run } from "./program.mjs";

process.exitCode = run();
