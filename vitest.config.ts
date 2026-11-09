/// <reference types="vitest/config" />
/// <reference types="vitest" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";
import { fileURLToPath } from "node:url";
import {
  coverageExclude,
  coverageInclude,
  unitTestInclude,
} from "./vitest.shared-unit-scope.ts";
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
      exclude: coverageExclude,
      // Thresholds: In Vitest 3.2.4, threshold numbers belong nested under
      // `thresholds` (e.g. thresholds.lines). The historical shape here —
      // `thresholds.global: { … }` — degenerated into a file glob named
      // "global" that matched nothing, so thresholds were never enforced;
      // the same "unknown key" rule explains why any other stray object is
      // silently ignored.
      //
      // IMPORTANT: even nested, the storybookTest plugin (@storybook/
      // addon-vitest 9.x) drops test.coverage.thresholds when it is
      // registered, regardless of project filtering (verified empirically),
      // so the floors below are NOT enforced by the combined command yet —
      // they are recorded for the day the plugin stops dropping them.
      // Enforcement is guaranteed for the unit-only scope by
      // `test:coverage:unit` (see coverage.enforce.config.ts and
      // scripts/check-coverage-thresholds.mjs).
      //
      // RATCHET FLOORS, NOT TARGET: held near the latest measured combined
      // run (see PR #193 for the exact numbers); the historical ~75%
      // figures are the target and require the ingestion program wired
      // into coverage (coordinates with #39) before they can be enforced.
      thresholds: {
        branches: 80,
        functions: 60,
        lines: 35,
        statements: 35,
      },
      include: coverageInclude,
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
          include: unitTestInclude,
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
