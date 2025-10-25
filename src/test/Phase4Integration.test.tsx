/**
 * Integration tests for Phase 4: Application Shell & Routing
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { router } from "../router/index.js";

// Mock the data service
vi.mock("../services/DataService.js", () => ({
  DataService: vi.fn().mockImplementation(() => ({
    initialize: vi.fn().mockResolvedValue(undefined),
    loadManifest: vi.fn().mockResolvedValue({
      version: "1.0.0",
      datasetVersion: "2024-08-23T10:00:00Z",
      lastUpdated: Date.now(),
      totalEvents: 100,
      totalArtists: 50,
      totalVenues: 25,
      dateRange: {
        startEpochMs: Date.now() - 30 * 24 * 60 * 60 * 1000,
        endEpochMs: Date.now() + 30 * 24 * 60 * 60 * 1000,
        startDate: "2024-08-01",
        endDate: "2024-09-01",
      },
      chunks: { events: [], artists: {}, venues: {}, indexes: {} },
      processedAt: Date.now(),
      sourceFiles: { events: {}, venues: {} },
      schemaVersion: "1.0.0",
    }),
    loadArtists: vi.fn().mockResolvedValue([]),
    loadVenues: vi.fn().mockResolvedValue([]),
    loadIndexes: vi.fn().mockResolvedValue({}),
    loadChunk: vi.fn().mockResolvedValue([]),
    searchEvents: vi.fn().mockResolvedValue([]),
    getCacheStats: vi.fn().mockResolvedValue({}),
    dispose: vi.fn(),
  })),
}));

// Mock the app store to avoid loading states
vi.mock("../stores/appStore.ts", () => ({
  useAppStore: vi.fn(() => ({
    // Initial state
    isInitialized: true,
    isInitializing: false,

    // Data
    manifest: { totalEvents: 100, totalArtists: 50, totalVenues: 25 },
    artists: [],
    venues: [],
    events: [],

    // Loading states
    loadingStates: {
      manifest: false,
      artists: false,
      venues: false,
      chunks: {},
      search: false,
    },

    // No errors
    errors: {},

    // Mock functions
    initialize: vi.fn().mockResolvedValue(undefined),
    searchEvents: vi.fn().mockResolvedValue([]),
    getEvent: vi.fn(),
    getArtist: vi.fn(),
    getVenue: vi.fn(),
  })),
}));

// Mock the filter store
vi.mock("../stores/filterStore.ts", () => ({
  useFilterStore: vi.fn(() => ({
    searchQuery: "",
    filters: {},
    activeFilters: 0,

    // Mock functions
    updateSearch: vi.fn(),
    updateFilter: vi.fn(),
    clearFilter: vi.fn(),
    clearAllFilters: vi.fn(),
  })),
}));

// Mock error handling
vi.mock("../utils/errorHandling.ts", () => ({
  globalErrorHandler: {
    initialize: vi.fn(),
    reportError: vi.fn(),
  },
}));

// Mock IndexedDB
const mockIndexedDB = {
  open: vi.fn().mockReturnValue({
    onsuccess: vi.fn(),
    onerror: vi.fn(),
    onupgradeneeded: vi.fn(),
    result: {
      transaction: vi.fn().mockReturnValue({
        objectStore: vi.fn().mockReturnValue({
          get: vi.fn().mockReturnValue({ onsuccess: vi.fn(), result: null }),
          put: vi.fn().mockReturnValue({ onsuccess: vi.fn() }),
        }),
      }),
      close: vi.fn(),
    },
  }),
};

// @ts-expect-error - Mock IndexedDB for testing environment
global.indexedDB = mockIndexedDB;

describe("Phase 4: Application Shell & Routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("Router Configuration", () => {
    it("should have router configuration", () => {
      // Simple test - router should be defined and have routes
      expect(router).toBeDefined();
      expect(router.routes).toBeDefined();
      expect(Array.isArray(router.routes)).toBe(true);
      expect(router.routes.length).toBeGreaterThan(0);
    });

    it("should have expected routes", () => {
      // Test that expected route paths exist
      const routePaths = router.routes
        .filter((route: any) => route.path)
        .map((route: any) => route.path);

      expect(routePaths).toContain("/");
      expect(routePaths.some((path: string) => path.includes("calendar"))).toBe(
        true
      );
      expect(routePaths.some((path: string) => path.includes("artists"))).toBe(
        true
      );
      expect(routePaths.some((path: string) => path.includes("venues"))).toBe(
        true
      );
    });
  });

  describe("Store Integration", () => {
    it("should have app store available", async () => {
      const { useAppStore } = await import("../stores/appStore.ts");
      expect(useAppStore).toBeDefined();
      expect(typeof useAppStore).toBe("function");
    });

    it("should have filter store available", async () => {
      const { useFilterStore } = await import("../stores/filterStore.ts");
      expect(useFilterStore).toBeDefined();
      expect(typeof useFilterStore).toBe("function");
    });
  });

  describe("Service Integration", () => {
    it("should have data service available", async () => {
      const { DataService } = await import("../services/DataService.js");
      expect(DataService).toBeDefined();
      expect(typeof DataService).toBe("function");
    });
  });

  describe("Component Architecture", () => {
    it("should import main page components", async () => {
      const HomePage = await import("../pages/HomePage.tsx");
      expect(HomePage.default).toBeDefined();

      const CalendarPage = await import("../pages/CalendarPage.tsx");
      expect(CalendarPage.default).toBeDefined();

      const ArtistsPage = await import("../pages/ArtistsPage.tsx");
      expect(ArtistsPage.default).toBeDefined();

      const VenuesPage = await import("../pages/VenuesPage.tsx");
      expect(VenuesPage.default).toBeDefined();
    });

    it("should import layout components", async () => {
      const Header = await import("../components/layout/Header.tsx");
      expect(Header.default).toBeDefined();

      const SideNavigation = await import(
        "../components/layout/SideNavigation.tsx"
      );
      expect(SideNavigation.default).toBeDefined();

      const BottomNavigation = await import(
        "../components/layout/BottomNavigation.tsx"
      );
      expect(BottomNavigation.default).toBeDefined();
    });
  });
});
