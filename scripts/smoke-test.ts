#!/usr/bin/env node
// Daily canary against the real Bandcamp, run by
// .github/workflows/smoke-test.yml and locally with `npm run smoke-test`.
// Prints a readable summary, writes smoke-result.json ({timestamp, ok,
// results}) for the workflow's issue report, and exits 1 if any check failed.
// The checks and their pass conditions live in smoke-lib.ts.
import { writeFileSync } from "node:fs";
import * as client from "../src/client/bandcampClient.js";
import { SMOKE_CHECKS, formatSummary, recordResponses, runSmoke } from "./smoke-lib.js";

const RESULT_FILE = "smoke-result.json";

// The client looks up the global fetch at request time, so this sees every
// request it sends.
const recorder = recordResponses(globalThis.fetch);
globalThis.fetch = recorder.fetch;

const summary = await runSmoke(SMOKE_CHECKS, client, { takeLastResponse: recorder.takeLast });

writeFileSync(RESULT_FILE, `${JSON.stringify(summary, null, 2)}\n`);
console.log(formatSummary(summary));
if (!summary.ok) process.exitCode = 1;
