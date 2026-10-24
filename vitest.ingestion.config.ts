import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  cacheDir: ".cache/vitest-ingestion",
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: {
    // Message-channel transport stays responsive during long SQLite/Git suites.
    pool: "threads",
    // Native Git/SQLite fixtures are synchronous; limit competing worker IO so
    // refusal checks retain their existing deadlines under the complete suite.
    maxWorkers: 2,
    setupFiles: ["./src/test/ingestion/setup.ts"],
    environment: "node",
    include: [
      "src/test/ingestion/**/*.test.ts",
      "src/test/ingestion/**/*.test.tsx",
      "src/test/etl/**/*.test.ts",
      "src/test/components/NewEventsPage.test.tsx",
      "src/test/components/NewsletterPage.test.tsx",
      "src/test/components/HomePage.test.tsx",
      "src/test/components/EventsPage.test.tsx",
      "src/test/components/EventDetailPage.test.tsx",
      "src/test/components/SavedDateFilters.test.tsx",
      "src/test/components/VenuesPage.test.tsx",
      "src/test/components/VenueMapPreview.test.tsx",
      "src/test/components/EventAtlasCard.test.tsx",
      "src/test/components/EventPosterLink.test.tsx",
      "src/test/components/ArtistVibeCard.test.tsx",
      "src/test/components/ArtistLinks.test.tsx",
      "src/test/components/ArtistCardHero.test.tsx",
      "src/test/components/NavigationActive.test.tsx",
    ],
    reporters: ["default"],
  },
});
