/**
 * Test suite for DataService functionality
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { DataService } from "../services/DataService.js";
import type { Event, Artist, Venue } from "../types/events.js";
import type { DataManifest } from "../types/data.js";

// Mock fetch globally
const mockFetch = vi.fn();
global.fetch = mockFetch;

// Mock IndexedDB for CacheService
const mockIndexedDB = {
  open: vi.fn(),
  deleteDatabase: vi.fn(),
};

// @ts-ignore
global.indexedDB = mockIndexedDB;

describe("DataService", () => {
  let dataService: DataService;
  let mockManifest: DataManifest;
  let mockArtists: Artist[];
  let mockVenues: Venue[];
  let mockEvents: Event[];

  beforeEach(() => {
    vi.clearAllMocks();
    
    dataService = new DataService({
      baseUrl: "/test-data",
      cacheName: "test-cache",
      maxCacheSize: 1024 * 1024, // 1MB for tests
      retryAttempts: 1, // Reduce retry attempts for faster tests
    });

    // Set up mock data
    mockManifest = {
      version: "1.0.0",
      datasetVersion: "2024-08-23T10:00:00Z",
      lastUpdated: Date.now(),
      totalEvents: 10,
      totalArtists: 5,
      totalVenues: 3,
      dateRange: {
        startEpochMs: Date.now() - 30 * 24 * 60 * 60 * 1000, // 30 days ago
        endEpochMs: Date.now() + 30 * 24 * 60 * 60 * 1000, // 30 days from now
        startDate: "2024-08-01",
        endDate: "2024-09-01",
      },
      chunks: {
        events: [
          {
            filename: "events-2024-08.json",
            chunkId: "2024-08",
            size: 1000,
            checksum: "abc123",
            eventCount: 10,
            dateRange: {
              startEpochMs: Date.now() - 30 * 24 * 60 * 60 * 1000,
              endEpochMs: Date.now() + 30 * 24 * 60 * 60 * 1000,
            },
          },
        ],
        artists: {
          filename: "artists.json",
          size: 500,
          checksum: "def456",
          recordCount: 5,
        },
        venues: {
          filename: "venues.json", 
          size: 300,
          checksum: "ghi789",
          recordCount: 3,
        },
        indexes: {
          filename: "indexes.json",
          size: 800,
          checksum: "jkl012",
        },
      },
      processedAt: Date.now(),
      sourceFiles: {
        events: {
          filename: "events.txt",
          size: 2000,
          lastModified: Date.now(),
          lineCount: 20,
          checksum: "source123",
        },
        venues: {
          filename: "venues.txt",
          size: 1000,
          lastModified: Date.now(),
          lineCount: 10,
          checksum: "source456",
        },
      },
      schemaVersion: "1.0.0",
    };

    mockArtists = [
      {
        id: 1 as any,
        name: "Test Artist 1",
        slug: "test-artist-1",
        normalizedName: "test artist 1",
        aliases: ["Artist 1"],
        upcomingEventCount: 2,
        totalEventCount: 5,
        createdAtEpochMs: Date.now(),
        updatedAtEpochMs: Date.now(),
      },
      {
        id: 2 as any,
        name: "Test Artist 2", 
        slug: "test-artist-2",
        normalizedName: "test artist 2",
        aliases: [],
        upcomingEventCount: 1,
        totalEventCount: 3,
        createdAtEpochMs: Date.now(),
        updatedAtEpochMs: Date.now(),
      },
    ];

    mockVenues = [
      {
        id: 1 as any,
        name: "Test Venue 1",
        slug: "test-venue-1",
        normalizedName: "test venue 1",
        address: "123 Test St",
        city: "San Francisco",
        ageRestriction: "21+" as any,
        upcomingEventCount: 3,
        totalEventCount: 10,
        createdAtEpochMs: Date.now(),
        updatedAtEpochMs: Date.now(),
        sourceLineNumber: 1,
      },
    ];

    mockEvents = [
      {
        id: 1 as any,
        slug: "test-event-1",
        date: "2024-08-15",
        dateEpochMs: Date.now() + 7 * 24 * 60 * 60 * 1000, // 7 days from now
        timezone: "America/Los_Angeles",
        headlinerArtistId: 1 as any,
        artistIds: [1 as any, 2 as any],
        venueId: 1 as any,
        priceMin: 25,
        priceMax: 25,
        isFree: false,
        ageRestriction: "21+" as any,
        status: "confirmed" as any,
        tags: [] as any,
        venueType: "club" as any,
        createdAtEpochMs: Date.now(),
        updatedAtEpochMs: Date.now(),
        sourceLineNumber: 1,
      },
    ];

    // Mock successful IDB operations
    const mockTransaction = {
      objectStore: vi.fn().mockReturnValue({
        get: vi.fn().mockReturnValue({ 
          onsuccess: vi.fn(),
          onerror: vi.fn(),
          result: null,
        }),
        put: vi.fn().mockReturnValue({
          onsuccess: vi.fn(),
          onerror: vi.fn(),
        }),
      }),
    };

    const mockDB = {
      transaction: vi.fn().mockReturnValue(mockTransaction),
      close: vi.fn(),
    };

    mockIndexedDB.open.mockReturnValue({
      onsuccess: vi.fn(),
      onerror: vi.fn(), 
      onupgradeneeded: vi.fn(),
      result: mockDB,
    });
  });

  afterEach(() => {
    dataService.dispose();
  });

  describe("loadManifest", () => {
    it("should load manifest from network", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockManifest),
      });

      const result = await dataService.loadManifest();
      
      expect(result).toEqual(mockManifest);
      expect(mockFetch).toHaveBeenCalledWith("/test-data/manifest.json", expect.any(Object));
    });

    it("should throw error on network failure", async () => {
      mockFetch.mockRejectedValueOnce(new Error("Network error"));

      await expect(dataService.loadManifest()).rejects.toThrow();
    });

    it("should return cached manifest on subsequent calls", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockManifest),
      });

      // First call
      const result1 = await dataService.loadManifest();
      // Second call (should use cached version)
      const result2 = await dataService.loadManifest();

      expect(result1).toEqual(result2);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });

  describe("loadArtists", () => {
    it("should load artists from network", async () => {
      // Mock manifest load
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockManifest),
      });

      // Mock artists load
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockArtists),
      });

      const result = await dataService.loadArtists();
      
      expect(result).toEqual(mockArtists);
      expect(mockFetch).toHaveBeenCalledWith("/test-data/artists.json", expect.any(Object));
    });

    it("should return cached artists on subsequent calls", async () => {
      // Mock manifest and artists load
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(mockManifest),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(mockArtists),
        });

      // First call
      const result1 = await dataService.loadArtists();
      // Second call (should use cached version)
      const result2 = await dataService.loadArtists();

      expect(result1).toEqual(result2);
      expect(mockFetch).toHaveBeenCalledTimes(2); // manifest + artists
    });
  });

  describe("getArtist", () => {
    it("should return artist by ID", async () => {
      // Load artists first
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(mockManifest),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(mockArtists),
        });

      await dataService.loadArtists();
      
      const artist = dataService.getArtist(1 as any);
      expect(artist).toEqual(mockArtists[0]);
    });

    it("should return null for non-existent artist", async () => {
      const artist = dataService.getArtist(999 as any);
      expect(artist).toBeNull();
    });
  });

  describe("error handling", () => {
    it("should handle HTTP errors", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        statusText: "Not Found",
      });

      await expect(dataService.loadManifest()).rejects.toThrow("HTTP 404: Not Found");
    });

    it("should handle JSON parsing errors", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.reject(new Error("Invalid JSON")),
      });

      await expect(dataService.loadManifest()).rejects.toThrow();
    });
  });

  describe("memory management", () => {
    it("should provide memory statistics", async () => {
      const stats = dataService.getMemoryStats();
      
      expect(stats).toHaveProperty("loadedChunks");
      expect(stats).toHaveProperty("eventsInMemory");
      expect(stats).toHaveProperty("artistsInMemory"); 
      expect(stats).toHaveProperty("venuesInMemory");
      expect(stats).toHaveProperty("estimatedSize");
    });
  });
});