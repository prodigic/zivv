/**
 * Single source of truth for the unit-scope test include list and the
 * coverage exclusion set, consumed by both vitest.config.ts (the "unit"
 * project) and coverage.enforce.config.ts (enforced unit-only coverage), so
 * test:unit and test:coverage:unit cannot silently diverge.
 *
 * This file deliberately does NOT match Vitest's automatic project
 * discovery pattern (vitest.*.config.ts) — it is a plain shared module.
 */

import { fileURLToPath } from "node:url";

/** Directory alias used by both configs. */
export const srcAlias = fileURLToPath(new URL("./src", import.meta.url));

/**
 * Test files collected by the JSDOM "unit" project: the legacy service /
 * store / component suites plus the shared root-level page component
 * suites. Page components exercised by the ingestion harness intentionally
 * stay in vitest.ingestion.config.ts (see its include list).
 */
export const unitTestInclude = [
  "src/App.test.tsx",
  "src/test/*.test.{ts,tsx}",
  "src/test/stores/**/*.test.{ts,tsx}",
  "src/test/components/CityPagination.test.tsx",
  "src/test/components/DatePagination.test.tsx",
];

/** Coverage globs for the enforceable unit scope (app code). */
export const coverageInclude = ["src/**/*.{ts,tsx}"];

/**
 * Coverage exclusions, each with its documented rationale. These mirror the
 * principle from the coverage scoping review: subsytems covered by dedicated
 * programs are excluded from this scope explicitly and with a reason, never
 * silently.
 */
export const coverageExclude = [
  "node_modules/**",
  "dist/**",
  "tests/**",
  "**/*.config.*",
  "**/*.d.ts",
  "src/test/**",
  "coverage/**",
  "public/**",
  "scripts/**",
  // Ingestion/ETL pipeline code is exercised by the dedicated native
  // ingestion project (vitest.ingestion.config.ts, `test:ingestion`)
  // running its own filesystem/SQLite/Git fixtures; it is not part of
  // the unit/storybook coverage scope.
  "src/lib/etl/**",
  "src/lib/ingestion/**",
  // Dev-server tooling runs only via `npm run dev` scripts
  "src/devserver/**",
  // Static catalog/demo data consumed as imports
  "src/data/**",
  "src/examples/**",
  // Web worker sources execute inside worker threads; their main-thread
  // fallback logic is covered via WorkerService tests
  "src/workers/**",
  // Type declaration modules contain no executable assertions
  "src/types/**",
  // Storybook story definitions are test sources, not app code
  "src/stories/**",
];
