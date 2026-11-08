import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

// Enforceable coverage scope: JSDOM unit/component tests only.
//
// Why a separate config? Two Vitest 3.2.4 quirks make threshold
// enforcement unreliable inside the main project config:
//   1. The @storybook/addon-vitest plugin silently drops
//      test.coverage.thresholds when it is registered, regardless of
//      project filtering (verified empirically with `thresholds: 100`).
//   2. `vitest.*.config.ts` filenames participate in Vitest's automatic
//      project discovery, which can also interfere with threshold
//      resolution. This config therefore uses a filename outside that
//      pattern (`coverage.enforce.config.*`).
// To guarantee enforcement in spite of provider behavior, the thresholds
// here are also cross-checked outside Vitest by
// scripts/check-coverage-thresholds.mjs as part of `test:coverage:unit`.
//
// Scope: subsets exercised by the unit project (App, services, stores,
// utils, page components handled by unit suites); ingestion-owned
// subsystems and browser-story scope stay out (see per-path comments in
// vitest.config.ts). Storybook stories are collected separately with
// `test:stories`.

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: "./src/test/setup.ts",
    include: [
      "src/App.test.tsx",
      "src/test/*.test.{ts,tsx}",
      "src/test/stores/**/*.test.{ts,tsx}",
      "src/test/components/CityPagination.test.tsx",
      "src/test/components/DatePagination.test.tsx",
    ],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "json-summary"],
      include: ["src/**/*.{ts,tsx}"],
      exclude: [
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
        // the unit coverage scope.
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
      ],
      reportsDirectory: "./coverage",
      thresholds: {
        // Nested `thresholds.{lines,…}` is the enforced shape in Vitest
        // 3.2.x (a stray object under `thresholds`, e.g. `global`, behaves
        // as a file glob and silently never enforces). The v8 provider
        // exit code is also cross-checked by
        // scripts/check-coverage-thresholds.mjs as part of
        // `test:coverage:unit`, making enforcement independent of provider
        // internals.
        //
        // Enforced floors for this unit-only scope, backed by measured
        // results of the collected suites (24.26% lines / 84.19% branches /
        // 59.5% functions / 24.26% statements) with small headroom for test
        // churn. Floors to ratchet upward as coverage grows.
        branches: 80,
        functions: 55,
        lines: 24,
        statements: 24,
      },
    },
  },
});
