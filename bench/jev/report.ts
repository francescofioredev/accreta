#!/usr/bin/env bun
/** Regenerate every generated table and chart in docs/research/2026-09-jev/ from results/. */
import { reportT3 } from "./tasks/report-t3.ts";

reportT3();
console.log("reports regenerated");
