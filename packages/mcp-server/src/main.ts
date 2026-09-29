#!/usr/bin/env bun
import { serveStdio } from "./stdio.ts";

if (import.meta.main) {
  try {
    await serveStdio();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
