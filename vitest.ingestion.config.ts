import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  cacheDir: ".cache/vitest-ingestion",
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: {
    environment: "node",
    include: [
      "src/test/ingestion/**/*.test.ts",
      "src/test/ingestion/**/*.test.tsx",
      "src/test/etl/**/*.test.ts",
      "src/test/components/NewEventsPage.test.tsx",
      "src/test/components/NewsletterPage.test.tsx",
    ],
    reporters: ["default"],
  },
});
