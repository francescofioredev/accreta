#!/usr/bin/env bun
/** Regenerate every generated table and chart in docs/research/2026-09-jev/ from results/. */
import { reportT3 } from "./tasks/report-t3.ts";
import { reportT3Ladder } from "./tasks/report-t3-ladder.ts";
import { reportT2, reportT2Atlas, reportT2Got } from "./tasks/report-t2.ts";
import { reportIngestCost, reportT1, reportT1Got } from "./tasks/report-t1.ts";
import { reportT4 } from "./tasks/report-t4.ts";
import { reportT3Got } from "./tasks/report-t3-got.ts";
import { reportHeadline } from "./tasks/report-headline.ts";

reportT3();
reportT3Ladder();
reportT2();
reportT2Atlas();
reportT2Got();
reportT1();
reportT1Got();
reportIngestCost();
reportT4();
reportT3Got();
reportHeadline();
console.log("reports regenerated");
