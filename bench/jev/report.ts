#!/usr/bin/env bun
/** Regenerate every generated table and chart in docs/research/2026-09-jev/ from results/. */
import { reportT3 } from "./tasks/report-t3.ts";
import { reportT3Ladder } from "./tasks/report-t3-ladder.ts";
import { reportT2 } from "./tasks/report-t2.ts";
import { reportT1 } from "./tasks/report-t1.ts";

reportT3();
reportT3Ladder();
reportT2();
reportT1();
console.log("reports regenerated");
