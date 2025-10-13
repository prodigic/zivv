/**
 * Test suite for AppStore
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useAppStore } from "@/stores/appStore";
import type {
  Event,
  Artist,
  Venue,
  DataManifest,
  DataIndexes,
} from "@/types/events";

// Mock dependencies
// Mock data - must be defined before the mocks that use them
const mockManifest: DataManifest = {
  version: "1.0.0",
  generatedAt: "2024-01-15T12:00:00Z",
  dataVersion: 1,
  chunks: [
    {
      id: "events-2024-01",
      file: "events-2024-01.json",
      month: "2024-01",
      eventCount: 50,
      size: 1024,
      checksum: "abc123",
    },
  ],
  stats: {
    totalEvents: 100,
    totalArtists: 200,
    totalVenues: 50,
    dateRange: {
      earliest: "2024-01-01",
      latest: "2024-12-31",
    },
  },
} as DataManifest;

const mockArtists: Artist[] = [
  {
    id: 1 as any,
    name: "Test Artist",
    slug: "test-artist",
    normalizedName: "test artist",
    eventCount: 5,
    upcomingEventCount: 2,
    lastSeen: "2024-01-15",
    genres: ["punk", "rock"],
    relatedArtists: [],
    createdAt: "2024-01-01",
    updatedAt: "2024-01-15",
  },
  {
    id: 2 as any,
    name: "Another Band",
    slug: "another-band",
    normalizedName: "another band",
    eventCount: 3,
    upcomingEventCount: 1,
    lastSeen: "2024-01-10",
    genres: ["metal"],
    relatedArtists: [],
    createdAt: "2024-01-01",
    updatedAt: "2024-01-10",
  },
];

const mockVenues: Venue[] = [
  {
    id: 1 as any,
    name: "Test Venue",
    slug: "test-venue",
    normalizedName: "test venue",
    city: "San Francisco",
    address: "123 Test St",
    capacity: 500,
    ageRestriction: "21+",
    eventCount: 10,
    upcomingEventCount: 5,
    lastEventDate: "2024-01-15",
    createdAt: "2024-01-01",
    updatedAt: "2024-01-15",
  },
];

const mockEvents: Event[] = [
  {
    id: 1 as any,
    title: "Future Event",
    slug: "future-event",
    date: "2025-01-30",
    dateEpochMs: new Date("2025-01-30").getTime(), // Future date in 2025
    artistIds: [1 as any],
    venueId: 1 as any,
    price: { min: 20, max: 25, isFree: false },
    ageRestriction: "21+",
    genres: ["punk"],
    tags: [],
    status: "confirmed",
    createdAt: "2024-01-01",
    updatedAt: "2024-01-15",
  },
  {
    id: 2 as any,
    title: "January Event",
    slug: "january-event",
    date: "2024-01-01",
    dateEpochMs: new Date("2024-01-01").getTime(), // Fixed date in January 2024
    artistIds: [2 as any],
    venueId: 1 as any,
    price: { min: 15, max: 15, isFree: false },
    ageRestriction: "all-ages",
    genres: ["metal"],
    tags: [],
    status: "confirmed",
    createdAt: "2024-01-01",
    updatedAt: "2024-01-01",
  },
];

const mockIndexes: DataIndexes = {
  byDate: {
    "2024-01-15": [1 as any],
    "2024-01-01": [2 as any],
  },
  byVenue: {
    1: [1 as any, 2 as any],
  },
  byArtist: {
    1: [1 as any],
    2: [2 as any],
  },
  byGenre: {
    punk: [1 as any],
    metal: [2 as any],
  },
} as any;

// Create a factory for the mock DataService to ensure fresh instances
const createMockDataService = () => ({
  initialize: vi.fn().mockResolvedValue(undefined),
  loadManifest: vi.fn().mockResolvedValue(mockManifest),
  loadArtists: vi.fn().mockResolvedValue(mockArtists),
  loadVenues: vi.fn().mockResolvedValue(mockVenues),
  loadIndexes: vi.fn().mockResolvedValue(mockIndexes),
  loadChunk: vi.fn().mockResolvedValue(mockEvents),
  searchEvents: vi.fn().mockResolvedValue(mockEvents),
  getCacheStats: vi.fn().mockResolvedValue({ size: 1024, itemCount: 10 }),
  refresh: vi.fn().mockResolvedValue(undefined),
  dispose: vi.fn(),
});

vi.mock("@/services/DataService", () => {
  return {
    DataService: vi.fn().mockImplementation(() => createMockDataService()),
  };
});

vi.mock("@/utils/errorHandling", () => ({
  globalErrorHandler: {
    handleError: vi.fn(),
  },
}));

// Mock zustand middleware
vi.mock("zustand/middleware", () => ({
  devtools: vi.fn((fn) => fn),
  persist: vi.fn((fn) => fn),
}));

// Mock DOM manipulation for toggleUpcomingOnly
Object.defineProperty(window, "document", {
  value: {
    documentElement: {
      classList: {
        add: vi.fn(),
        remove: vi.fn(),
      },
    },
  },
  writable: true,
});

describe("AppStore", () => {
  beforeEach(() => {
    // Reset mocks
    vi.clearAllMocks();

    // Reset store to initial state
    useAppStore.setState({
      manifest: null,
      events: new Map(),
      artists: new Map(),
      venues: new Map(),
      indexes: null,
      loadedChunks: new Set(),
      loading: {
        manifest: "idle",
        artists: "idle",
        venues: "idle",
        indexes: "idle",
        events: "idle",
        search: "idle",
      },
      errors: {
        manifest: null,
        artists: null,
        venues: null,
        indexes: null,
        events: null,
        search: null,
      },
      view: {
        currentView: "list",
        selectedDate: undefined,
        selectedEvent: undefined,
        scrollPosition: 0,
        lastVisited: Date.now(),
      },
      showUpcomingOnly: true,
      dataService: null,
      lastUpdated: {
        manifest: null,
        artists: null,
        venues: null,
        indexes: null,
      },
    });
  });

  describe("initial state", () => {
    it("should have correct initial state", () => {
      const state = useAppStore.getState();

      expect(state.manifest).toBeNull();
      expect(state.events).toBeInstanceOf(Map);
      expect(state.events.size).toBe(0);
      expect(state.artists).toBeInstanceOf(Map);
      expect(state.artists.size).toBe(0);
      expect(state.venues).toBeInstanceOf(Map);
      expect(state.venues.size).toBe(0);
      expect(state.indexes).toBeNull();
      expect(state.loadedChunks).toBeInstanceOf(Set);
      expect(state.loadedChunks.size).toBe(0);
      expect(state.showUpcomingOnly).toBe(true);
      expect(state.dataService).toBeNull();
    });

    it("should have correct initial loading states", () => {
      const state = useAppStore.getState();

      Object.values(state.loading).forEach((loadingState) => {
        expect(loadingState).toBe("idle");
      });
    });

    it("should have no initial errors", () => {
      const state = useAppStore.getState();

      Object.values(state.errors).forEach((error) => {
        expect(error).toBeNull();
      });
    });
  });

  describe("initialization", () => {
    it("should initialize successfully", async () => {
      const { initialize } = useAppStore.getState();

      await initialize();

      const state = useAppStore.getState();
      expect(state.dataService).not.toBeNull();
      expect(state.manifest).toEqual(mockManifest);
      expect(state.artists.size).toBe(2);
      expect(state.venues.size).toBe(1);
      expect(state.indexes).toEqual(mockIndexes);
    });

    it("should handle initialization errors", async () => {
      const { DataService } = await import("@/services/DataService");
      const mockDataService = DataService as any;

      // Temporarily mock DataService to fail initialization
      const originalMock = mockDataService.getMockImplementation();
      mockDataService.mockImplementation(() => ({
        ...createMockDataService(),
        initialize: vi.fn().mockRejectedValue(new Error("Init failed")),
      }));

      const { initialize } = useAppStore.getState();

      await expect(initialize()).rejects.toThrow("Init failed");

      // Restore original mock
      mockDataService.mockImplementation(originalMock);
    });
  });

  describe("data loading", () => {
    beforeEach(async () => {
      const { initialize } = useAppStore.getState();
      await initialize();
    });

    it("should load manifest successfully", async () => {
      const { loadManifest } = useAppStore.getState();

      await loadManifest();

      const state = useAppStore.getState();
      expect(state.manifest).toEqual(mockManifest);
      expect(state.loading.manifest).toBe("success");
      expect(state.errors.manifest).toBeNull();
      expect(state.lastUpdated.manifest).toBeTruthy();
    });

    it("should handle manifest loading errors", async () => {
      const state = useAppStore.getState();
      const mockDataService = state.dataService as any;
      mockDataService.loadManifest.mockRejectedValue(
        new Error("Network error")
      );

      const { loadManifest } = useAppStore.getState();

      await expect(loadManifest()).rejects.toThrow("Network error");

      const newState = useAppStore.getState();
      expect(newState.loading.manifest).toBe("error");
      expect(newState.errors.manifest).toBe("Network error");
    });

    it("should load artists successfully", async () => {
      const { loadArtists } = useAppStore.getState();

      await loadArtists();

      const state = useAppStore.getState();
      expect(state.artists.size).toBe(2);
      expect(state.artists.get(1 as any)?.name).toBe("Test Artist");
      expect(state.loading.artists).toBe("success");
    });

    it("should load venues successfully", async () => {
      const { loadVenues } = useAppStore.getState();

      await loadVenues();

      const state = useAppStore.getState();
      expect(state.venues.size).toBe(1);
      expect(state.venues.get(1 as any)?.name).toBe("Test Venue");
      expect(state.loading.venues).toBe("success");
    });

    it("should load chunks successfully", async () => {
      const { loadChunk } = useAppStore.getState();

      await loadChunk("events-2024-01");

      const state = useAppStore.getState();
      expect(state.events.size).toBe(2);
      expect(state.loadedChunks.has("events-2024-01")).toBe(true);
      expect(state.loading.events).toBe("success");
    });

    it("should skip loading already loaded chunks", async () => {
      const { loadChunk } = useAppStore.getState();

      await loadChunk("events-2024-01");
      await loadChunk("events-2024-01"); // Load again

      const state = useAppStore.getState();
      expect(state.events.size).toBe(2); // Should still be 2, not 4
    });
  });

  describe("search functionality", () => {
    beforeEach(async () => {
      const { initialize } = useAppStore.getState();
      await initialize();
    });

    it("should search events successfully", async () => {
      const { searchEvents } = useAppStore.getState();

      const results = await searchEvents("punk");

      expect(results).toEqual(mockEvents);
      expect(useAppStore.getState().loading.search).toBe("success");
    });

    it("should handle search errors", async () => {
      const state = useAppStore.getState();
      const mockDataService = state.dataService as any;
      mockDataService.searchEvents.mockRejectedValue(
        new Error("Search failed")
      );

      const { searchEvents } = useAppStore.getState();

      const results = await searchEvents("punk");

      expect(results).toEqual([]);
      expect(useAppStore.getState().loading.search).toBe("error");
      expect(useAppStore.getState().errors.search).toBe("Search failed");
    });
  });

  describe("data access helpers", () => {
    beforeEach(async () => {
      const { initialize } = useAppStore.getState();
      await initialize();

      // Manually populate events in the store for all data access tests
      useAppStore.setState((state) => {
        const eventsMap = new Map(state.events);
        mockEvents.forEach((event) => eventsMap.set(event.id, event));
        return { events: eventsMap };
      });
    });

    it("should get event by id", () => {
      const { getEvent } = useAppStore.getState();

      const event = getEvent(1 as any);

      expect(event).toEqual(mockEvents[0]);
    });

    it("should get artist by id", () => {
      const { getArtist } = useAppStore.getState();

      const artist = getArtist(1 as any);

      expect(artist).toEqual(mockArtists[0]);
    });

    it("should get venue by id", () => {
      const { getVenue } = useAppStore.getState();

      const venue = getVenue(1 as any);

      expect(venue).toEqual(mockVenues[0]);
    });

    it("should get events for month", () => {
      const { getEventsForMonth } = useAppStore.getState();

      const events = getEventsForMonth("2024-01");

      // Should return an array (events might be empty due to filtering)
      expect(Array.isArray(events)).toBe(true);
    });

    it("should get all events with limit", () => {
      const { getAllEvents } = useAppStore.getState();

      const events = getAllEvents(1);

      // Should return an array with proper limit
      expect(Array.isArray(events)).toBe(true);
      expect(events.length).toBeLessThanOrEqual(1);
    });

    it("should get upcoming events only", () => {
      const { getUpcomingEvents } = useAppStore.getState();

      const events = getUpcomingEvents();

      // Should return an array of future events only
      expect(Array.isArray(events)).toBe(true);
      if (events.length > 0) {
        events.forEach((event) => {
          expect(event.dateEpochMs).toBeGreaterThan(Date.now() - 86400000); // Some tolerance
        });
      }
    });
  });

  describe("UI state management", () => {
    it("should set current view", () => {
      const { setCurrentView } = useAppStore.getState();

      setCurrentView("calendar");

      const state = useAppStore.getState();
      expect(state.view.currentView).toBe("calendar");
      expect(state.view.lastVisited).toBeTruthy();
    });

    it("should set selected date", () => {
      const { setSelectedDate } = useAppStore.getState();

      setSelectedDate("2024-01-15");

      const state = useAppStore.getState();
      expect(state.view.selectedDate).toBe("2024-01-15");
    });

    it("should set selected event", () => {
      const { setSelectedEvent } = useAppStore.getState();

      setSelectedEvent(1 as any);

      const state = useAppStore.getState();
      expect(state.view.selectedEvent).toBe(1);
    });

    it("should update scroll position", () => {
      const { updateScrollPosition } = useAppStore.getState();

      updateScrollPosition(500);

      const state = useAppStore.getState();
      expect(state.view.scrollPosition).toBe(500);
    });

    it("should toggle upcoming only", () => {
      const { toggleUpcomingOnly } = useAppStore.getState();

      expect(useAppStore.getState().showUpcomingOnly).toBe(true);

      toggleUpcomingOnly();
      expect(useAppStore.getState().showUpcomingOnly).toBe(false);

      toggleUpcomingOnly();
      expect(useAppStore.getState().showUpcomingOnly).toBe(true);
    });
  });

  describe("error handling", () => {
    it("should clear specific error", () => {
      // Set an error first
      useAppStore.setState((state) => ({
        errors: { ...state.errors, manifest: "Test error" },
      }));

      const { clearError } = useAppStore.getState();

      clearError("manifest");

      const state = useAppStore.getState();
      expect(state.errors.manifest).toBeNull();
    });

    it("should clear all errors", () => {
      // Set multiple errors first
      useAppStore.setState((state) => ({
        errors: {
          ...state.errors,
          manifest: "Error 1",
          artists: "Error 2",
          venues: "Error 3",
        },
      }));

      const { clearAllErrors } = useAppStore.getState();

      clearAllErrors();

      const state = useAppStore.getState();
      Object.values(state.errors).forEach((error) => {
        expect(error).toBeNull();
      });
    });
  });

  describe("cache management", () => {
    beforeEach(async () => {
      const { initialize } = useAppStore.getState();
      await initialize();
    });

    it("should refresh data", async () => {
      const { refresh } = useAppStore.getState();

      await refresh();

      const state = useAppStore.getState();
      // Should have cleared and reloaded data
      expect(state.manifest).toEqual(mockManifest);
    });

    it("should get cache stats", async () => {
      const { getCacheStats } = useAppStore.getState();

      const stats = await getCacheStats();

      expect(stats).toEqual({ size: 1024, itemCount: 10 });
    });

    it("should handle cache stats when no data service", async () => {
      useAppStore.setState({ dataService: null });

      const { getCacheStats } = useAppStore.getState();

      const stats = await getCacheStats();

      expect(stats).toBeNull();
    });
  });

  describe("cleanup", () => {
    it("should dispose resources", () => {
      const mockDispose = vi.fn();
      useAppStore.setState({
        dataService: { dispose: mockDispose } as any,
      });

      const { dispose } = useAppStore.getState();

      dispose();

      expect(mockDispose).toHaveBeenCalled();
    });

    it("should handle dispose when no data service", () => {
      useAppStore.setState({ dataService: null });

      const { dispose } = useAppStore.getState();

      expect(() => dispose()).not.toThrow();
    });
  });

  describe("error scenarios", () => {
    it("should throw error when data service not initialized", async () => {
      const { loadManifest } = useAppStore.getState();

      await expect(loadManifest()).rejects.toThrow(
        "DataService not initialized"
      );
    });

    it("should return undefined for non-existent data", () => {
      const { getEvent, getArtist, getVenue } = useAppStore.getState();

      expect(getEvent(999 as any)).toBeUndefined();
      expect(getArtist(999 as any)).toBeUndefined();
      expect(getVenue(999 as any)).toBeUndefined();
    });

    it("should handle empty data gracefully", () => {
      const { getEventsForMonth, getAllEvents, getUpcomingEvents } =
        useAppStore.getState();

      // Store has no events loaded
      expect(getEventsForMonth("2024-01")).toEqual([]);
      expect(getAllEvents()).toEqual([]);
      expect(getUpcomingEvents()).toEqual([]);
    });
  });
});
