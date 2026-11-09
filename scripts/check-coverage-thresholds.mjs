// Deterministic coverage threshold enforcement for the unit-only scope
// (coverage.enforce.config.ts). Vitest's internal threshold check is
// unreliable in this repo (the @storybook/addon-vitest plugin drops
// test.coverage.thresholds even when it is not the selected project), so
// `test:coverage:unit` re-checks the same floors against the JSON summary
// the v8 provider emits. Fails closed: every metric must be present, and
// the summary must be fresh (written by the vitest run this script is
// chained after), otherwise exit code 1.

import { readFileSync, existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const configModule = await import(
  pathToFileURL(path.join(root, "coverage.enforce.config.ts"))
);
const thresholds = configModule.default?.test?.coverage?.thresholds;
if (!thresholds || typeof thresholds !== "object") {
  console.error(
    "ERROR: coverage.enforce.config.ts does not define test.coverage.thresholds"
  );
  process.exit(1);
}

// All floors must be explicit numbers — a deleted or renamed metric key
// must fail the check, never silently skip a metric.
const METRICS = ["lines", "branches", "functions", "statements"];
const floors = {};
for (const key of METRICS) {
  const value = thresholds[key];
  if (typeof value !== "number") {
    console.error(
      `ERROR: thresholds.${key} is missing or not a number in coverage.enforce.config.ts — thresholds must define all of ${METRICS.join(", ")}`
    );
    process.exit(1);
  }
  floors[key] = value;
}

const summaryPath = path.join(root, "coverage", "coverage-summary.json");
if (!existsSync(summaryPath)) {
  console.error(
    "ERROR: coverage/coverage-summary.json not found — it must be produced by the vitest run chained before this check"
  );
  process.exit(1);
}

// Freshness guard: the summary is only valid if it was written after the
// corresponding vitest run started. `test:coverage:unit` chains the check
// right after the vitest process; when running this script standalone, a
// summary older than --max-age seconds is rejected to prevent stale
// reports from passing.
const maxAgeSeconds = Number(
  process.argv
    .slice(process.argv.indexOf("--max-age") + 1)
    .find((arg) => /^\d+$/.test(arg)) ?? "900"
);
const summaryAgeSeconds = (Date.now() - statSync(summaryPath).mtimeMs) / 1000;
if (summaryAgeSeconds > maxAgeSeconds) {
  console.error(
    `ERROR: coverage/coverage-summary.json is stale (${Math.round(summaryAgeSeconds)}s old, limit ${maxAgeSeconds}s) — rerun the coverage command instead of trusting stale evidence`
  );
  process.exit(1);
}

const summary = JSON.parse(readFileSync(summaryPath, "utf8")).total;

let failed = false;
for (const key of METRICS) {
  const cov = summary?.[key];
  if (typeof cov?.pct !== "number") {
    console.error(`ERROR: summary is missing "${key}" data`);
    process.exit(1);
  }
  const ok = cov.pct >= floors[key];
  console.log(
    `${ok ? "OK  " : "FAIL"} ${key.padEnd(11)} ${String(cov.pct).padStart(7)}% (floor ${floors[key]}%)`
  );
  if (!ok) failed = true;
}

if (failed) {
  console.error("ERROR: Coverage thresholds not met");
  process.exit(1);
}
console.log("OK   all coverage floors met");
