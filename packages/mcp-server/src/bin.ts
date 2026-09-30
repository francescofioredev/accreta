#!/usr/bin/env node
import { launch } from "@accreta/core/runtime";

await launch(async () => (await import("./stdio.ts")).main);
