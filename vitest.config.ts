/// <reference types="vitest/config" />
/// <reference types="vitest" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";
import { fileURLToPath } from "node:url";
import { storybookTest } from "@storybook/addon-vitest/vitest-plugin";
const dirname =
  typeof __dirname !== "undefined"
    ? __dirname
    : path.dirname(fileURLToPath(import.meta.url));

// More info at: https://storybook.js.org/docs/next/writing-tests/integrations/vitest-addon
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "@/components": path.resolve(__dirname, "./src/components"),
      "@/utils": path.resolve(__dirname, "./src/utils"),
      "@/types": path.resolve(__dirname, "./src/types"),
      "@/hooks": path.resolve(__dirname, "./src/hooks"),
      "@/stores": path.resolve(__dirname, "./src/stores"),
      "@/pages": path.resolve(__dirname, "./src/pages"),
      "@/services": path.resolve(__dirname, "./src/services"),
      "@/lib": path.resolve(__dirname, "./src/lib"),
    },
  },
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: "./src/test/setup.ts",
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "json"],
      reportsDirectory: "./coverage",
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
        // the unit/storybook coverage scope.
        "src/lib/etl/**",
        "src/lib/ingestion/**",
        // Dev-server tooling runs only via `npm run dev` scripts
        "src/devserver/**",
        // Static catalog/demo data consumed as imports
        "src/data/**",
        "src/examples/**",
        // Web worker sources execute inside worker threads; their main-thread
        // fallback logic is covered via WorkerService/WorkerService tests
        "src/workers/**",
        // Type declaration modules contain no executable assertions
        "src/types/**",
        // Storybook story definitions are test sources, not app code
        "src/stories/**",
      ],
      // Thresholds must be top-level keys here. Vitest 3.2.x interprets any
      // other key (including a nested `global` object) as a file glob that
      // matches nothing, silently skipping threshold enforcement otherwise.
      //
      // Realistic floors for the unit + storybook scope (reported 35.32%
      // lines / 83.5% branches / 62.65% functions after collecting the full
      // legacy suites). These are floors to ratchet upward; page/component
      // depth is additionally exercised by the ingestion suite, and coverage
      // wiring for that program is tracked in #39.
      branches: 80,
      functions: 60,
      lines: 35,
      statements: 35,
      include: ["src/**/*.{ts,tsx}"],
    },
    reporters: ["verbose", "html"],
    outputFile: {
      html: "./test-results/unit-tests.html",
    },
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          // Legacy JSDOM unit/component suites that were never collected by
          // the default command. They run outside the ingestion harness and
          // without any browser setup.
          include: [
            "src/App.test.tsx",
            "src/test/*.test.{ts,tsx}",
            "src/test/stores/**/*.test.{ts,tsx}",
            "src/test/components/CityPagination.test.tsx",
            "src/test/components/DatePagination.test.tsx",
          ],
        },
      },
      {
        extends: true,
        plugins: [
          // The plugin will run tests for the stories defined in your Storybook config
          // See options at: https://storybook.js.org/docs/next/writing-tests/integrations/vitest-addon#storybooktest
          storybookTest({
            configDir: path.join(dirname, ".storybook"),
          }),
        ],
        test: {
          name: "storybook",
          browser: {
            enabled: true,
            headless: true,
            provider: "playwright",
            instances: [
              {
                browser: "chromium",
              },
            ],
          },
          setupFiles: [".storybook/vitest.setup.ts"],
        },
      },
    ],
  },
});
