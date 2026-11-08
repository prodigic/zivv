// Deterministic coverage threshold enforcement for the unit-only scope
// (coverage.enforce.config.ts). Vitest's internal threshold check is
// unreliable in this repo (the @storybook/addon-vitest plugin drops
// test.coverage.thresholds even when it is not the selected project), so
// `test:coverage:unit` re-checks the same floors against the JSON summary
// the v8 provider emits. Fails with exit code 1 when a floor is missed.

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const configModule = await import(
  pathToFileURL(path.join(root, "coverage.enforce.config.ts"))
);
const thresholds = configModule.default?.test?.coverage?.thresholds;
if (!thresholds) {
  console.error(
    "ERROR: coverage.enforce.config.ts does not define test.coverage.thresholds"
  );
  process.exit(1);
}

const summaryPath = path.join(root, "coverage", "coverage-summary.json");
if (!existsSync(summaryPath)) {
  console.error(
    "ERROR: coverage/coverage-summary.json not found — run vitest with the json-summary reporter first"
  );
  process.exit(1);
}

const summary = JSON.parse(readFileSync(summaryPath, "utf8")).total;

let failed = false;
for (const key of ["lines", "branches", "functions", "statements"]) {
  const floor = thresholds[key];
  if (typeof floor !== "number") continue;
  const cov = summary?.[key];
  if (typeof cov?.pct !== "number") {
    console.error(`ERROR: summary is missing "${key}" data`);
    process.exit(1);
  }
  const ok = cov.pct >= floor;
  console.log(
    `${ok ? "OK  " : "FAIL"} ${key.padEnd(11)} ${String(cov.pct).padStart(7)}% (floor ${floor}%)`
  );
  if (!ok) failed = true;
}

if (failed) {
  console.error("ERROR: Coverage thresholds not met");
  process.exit(1);
}
console.log("OK   all coverage floors met");
