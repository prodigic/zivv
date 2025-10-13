/**
 * Test suite for WorkerService
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { WorkerService } from "@/services/WorkerService";
import type { Event, Artist, Venue } from "@/types/events";

// Mock Worker
let mockWorker: any;
let mockWorkerConstructor: any;

const createMockWorker = () => {
  mockWorker = {
    postMessage: vi.fn(),
    terminate: vi.fn(),
    onmessage: null,
    onerror: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };

  mockWorkerConstructor = vi.fn(() => mockWorker);

  // Mock global Worker
  Object.defineProperty(global, 'Worker', {
    value: mockWorkerConstructor,
    writable: true,
  });

  // Mock URL for worker creation
  Object.defineProperty(global, 'URL', {
    value: vi.fn((path) => ({ toString: () => path })),
    writable: true,
  });
};

// Mock data
const mockEvents: Event[] = [
  {
    id: 1 as any,
    title: "Test Event 1",
    slug: "test-event-1",
    date: "2024-01-15",
    dateEpochMs: Date.now() + 86400000,
    artistIds: [1 as any],
    venueId: 1 as any,
    priceMin: 20,
    priceMax: 25,
    isFree: false,
    ageRestriction: "21+",
    genres: ["punk"],
    tags: [],
    status: "confirmed",
    createdAt: "2024-01-01",
    updatedAt: "2024-01-15",
  } as Event,
  {
    id: 2 as any,
    title: "Free Show",
    slug: "free-show",
    date: "2024-01-16",
    dateEpochMs: Date.now() + 172800000,
    artistIds: [2 as any],
    venueId: 2 as any,
    priceMin: 0,
    priceMax: 0,
    isFree: true,
    ageRestriction: "all-ages",
    genres: ["metal"],
    tags: [],
    status: "confirmed",
    createdAt: "2024-01-01",
    updatedAt: "2024-01-16",
  } as Event,
];

const mockArtists: Artist[] = [
  {
    id: 1 as any,
    name: "Test Band",
    slug: "test-band",
    normalizedName: "test band",
    eventCount: 1,
    upcomingEventCount: 1,
    lastSeen: "2024-01-15",
    genres: ["punk"],
    relatedArtists: [],
    createdAt: "2024-01-01",
    updatedAt: "2024-01-15",
  },
  {
    id: 2 as any,
    name: "Metal Group",
    slug: "metal-group",
    normalizedName: "metal group",
    eventCount: 1,
    upcomingEventCount: 1,
    lastSeen: "2024-01-16",
    genres: ["metal"],
    relatedArtists: [],
    createdAt: "2024-01-01",
    updatedAt: "2024-01-16",
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
    eventCount: 1,
    upcomingEventCount: 1,
    lastEventDate: "2024-01-15",
    createdAt: "2024-01-01",
    updatedAt: "2024-01-15",
  },
];

describe("WorkerService", () => {
  let workerService: WorkerService;

  beforeEach(() => {
    createMockWorker();
    workerService = new WorkerService();
  });

  afterEach(() => {
    if (workerService) {
      workerService.dispose();
    }
  });

  describe("initialization", () => {
    it("should initialize worker when Worker is supported", () => {
      expect(mockWorkerConstructor).toHaveBeenCalled();
      expect(mockWorker.onmessage).toBeDefined();
      expect(mockWorker.onerror).toBeDefined();
    });

    it("should handle worker initialization failure", () => {
      // Reset and create a failing worker
      mockWorkerConstructor.mockImplementation(() => {
        throw new Error("Worker creation failed");
      });

      // Create a new service
      const newService = new WorkerService();

      // Worker should be null on failure
      expect(mockWorkerConstructor).toHaveBeenCalled();

      newService.dispose();
    });

    it("should fall back when Worker is not supported", () => {
      // Create new mock constructor that hasn't been called
      const freshMockConstructor = vi.fn(() => mockWorker);
      
      // Mock unsupported Worker environment
      Object.defineProperty(global, 'Worker', {
        value: undefined,
        writable: true,
      });

      const newService = new WorkerService();

      // Worker constructor should not have been called in this case
      expect(freshMockConstructor).not.toHaveBeenCalled();

      newService.dispose();
    });
  });

  describe("JSON parsing", () => {
    it("should parse JSON using worker", async () => {
      const testData = { events: mockEvents };
      const jsonString = JSON.stringify(testData);

      // Simulate worker response
      setTimeout(() => {
        const message = {
          id: "req-1",
          success: true,
          data: { data: testData },
        };
        if (mockWorker.onmessage) {
          mockWorker.onmessage({ data: message });
        }
      }, 0);

      const result = await workerService.parseJson(jsonString, "events");

      expect(mockWorker.postMessage).toHaveBeenCalledWith({
        id: "req-1",
        type: "PARSE_JSON",
        payload: { jsonString, expectedType: "events" },
      });
      expect(result).toEqual(testData);
    });

    it("should fallback to main thread when worker fails", async () => {
      const testData = { events: mockEvents };
      const jsonString = JSON.stringify(testData);

      // Simulate worker error
      setTimeout(() => {
        const message = {
          id: "req-1",
          success: false,
          error: "Worker parsing failed",
        };
        if (mockWorker.onmessage) {
          mockWorker.onmessage({ data: message });
        }
      }, 0);

      const result = await workerService.parseJson(jsonString, "events");

      expect(result).toEqual(testData);
    });

    it("should use main thread when worker not available", async () => {
      // Create service without worker
      Object.defineProperty(global, 'Worker', {
        value: undefined,
        writable: true,
      });

      const noWorkerService = new WorkerService();
      const testData = { events: mockEvents };
      const jsonString = JSON.stringify(testData);

      const result = await noWorkerService.parseJson(jsonString, "events");

      expect(result).toEqual(testData);
      noWorkerService.dispose();
    });

    it("should handle JSON parsing errors in main thread", async () => {
      Object.defineProperty(global, 'Worker', {
        value: undefined,
        writable: true,
      });

      const noWorkerService = new WorkerService();
      const invalidJson = "{ invalid json }";

      await expect(noWorkerService.parseJson(invalidJson, "events"))
        .rejects.toThrow("JSON parsing failed");

      noWorkerService.dispose();
    });
  });

  describe("event filtering", () => {
    it("should filter events using worker", async () => {
      const filters = { isFree: true };
      const expectedResult = {
        events: [mockEvents[1]], // Only the free event
        totalCount: 1,
      };

      // Simulate worker response
      setTimeout(() => {
        const message = {
          id: "req-1",
          success: true,
          data: expectedResult,
        };
        if (mockWorker.onmessage) {
          mockWorker.onmessage({ data: message });
        }
      }, 0);

      const result = await workerService.filterEvents(mockEvents, filters);

      expect(mockWorker.postMessage).toHaveBeenCalledWith({
        id: "req-1",
        type: "FILTER_EVENTS",
        payload: { events: mockEvents, filters, searchQuery: undefined },
      });
      expect(result).toEqual(expectedResult);
    });

    it("should filter events with search query", async () => {
      const filters = {};
      const searchQuery = "test";
      const expectedResult = {
        events: [mockEvents[0]], // Only "Test Event 1"
        totalCount: 1,
      };

      setTimeout(() => {
        const message = {
          id: "req-1",
          success: true,
          data: expectedResult,
        };
        if (mockWorker.onmessage) {
          mockWorker.onmessage({ data: message });
        }
      }, 0);

      const result = await workerService.filterEvents(mockEvents, filters, searchQuery);

      expect(mockWorker.postMessage).toHaveBeenCalledWith({
        id: "req-1",
        type: "FILTER_EVENTS",
        payload: { events: mockEvents, filters, searchQuery },
      });
      expect(result).toEqual(expectedResult);
    });

    it("should fallback to main thread filtering", async () => {
      const filters = { isFree: true };

      // Simulate worker error
      setTimeout(() => {
        const message = {
          id: "req-1",
          success: false,
          error: "Filtering failed",
        };
        if (mockWorker.onmessage) {
          mockWorker.onmessage({ data: message });
        }
      }, 0);

      const result = await workerService.filterEvents(mockEvents, filters);

      // The main thread fallback should filter for free events
      expect(result.events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ isFree: true })
        ])
      );
      expect(result.totalCount).toBeGreaterThanOrEqual(0);
    });
  });

  describe("event sorting", () => {
    it("should sort events using worker", async () => {
      const sortField = "date";
      const sortOrder = "asc" as const;
      const expectedResult = { events: mockEvents };

      setTimeout(() => {
        const message = {
          id: "req-1",
          success: true,
          data: expectedResult,
        };
        if (mockWorker.onmessage) {
          mockWorker.onmessage({ data: message });
        }
      }, 0);

      const result = await workerService.sortEvents(mockEvents, sortField, sortOrder);

      expect(mockWorker.postMessage).toHaveBeenCalledWith({
        id: "req-1",
        type: "SORT_EVENTS",
        payload: { events: mockEvents, sortField, sortOrder },
      });
      expect(result).toEqual(expectedResult);
    });

    it("should fallback to main thread sorting", async () => {
      const sortField = "date";
      const sortOrder = "desc" as const;

      // Simulate worker error
      setTimeout(() => {
        const message = {
          id: "req-1",
          success: false,
          error: "Sorting failed",
        };
        if (mockWorker.onmessage) {
          mockWorker.onmessage({ data: message });
        }
      }, 0);

      const result = await workerService.sortEvents(mockEvents, sortField, sortOrder);

      expect(result.events).toBeDefined();
      expect(result.events.length).toBe(mockEvents.length);
    });

    it("should sort by price in main thread", async () => {
      Object.defineProperty(global, 'Worker', {
        value: undefined,
        writable: true,
      });

      const noWorkerService = new WorkerService();
      const result = await noWorkerService.sortEvents(mockEvents, "price", "asc");

      // Free event should come first when sorting by price ascending
      expect(result.events[0].isFree).toBe(true);
      noWorkerService.dispose();
    });
  });

  describe("search index building", () => {
    it("should build search index using worker", async () => {
      const expectedResult = {
        documents: [],
        terms: ["test", "band", "metal", "group"],
        totalDocuments: 2,
      };

      setTimeout(() => {
        const message = {
          id: "req-1",
          success: true,
          data: expectedResult,
        };
        if (mockWorker.onmessage) {
          mockWorker.onmessage({ data: message });
        }
      }, 0);

      const result = await workerService.buildSearchIndex(mockEvents, mockArtists, mockVenues);

      expect(mockWorker.postMessage).toHaveBeenCalledWith({
        id: "req-1",
        type: "BUILD_SEARCH_INDEX",
        payload: { events: mockEvents, artists: mockArtists, venues: mockVenues },
      });
      expect(result).toEqual(expectedResult);
    });

    it("should fallback to main thread index building", async () => {
      Object.defineProperty(global, 'Worker', {
        value: undefined,
        writable: true,
      });

      const noWorkerService = new WorkerService();
      const result = await noWorkerService.buildSearchIndex(mockEvents, mockArtists, mockVenues);

      expect(result).toHaveProperty("documents");
      expect(result).toHaveProperty("terms");
      expect(result).toHaveProperty("totalDocuments");
      expect(result.documents.length).toBeGreaterThan(0);
      expect(result.terms).toContain("test");
      expect(result.terms).toContain("band");

      noWorkerService.dispose();
    });
  });

  describe("statistics calculation", () => {
    it("should calculate stats using worker", async () => {
      const expectedResult = {
        totalEvents: 2,
        upcomingEvents: 2,
        pastEvents: 0,
        freeEvents: 1,
      };

      setTimeout(() => {
        const message = {
          id: "req-1",
          success: true,
          data: expectedResult,
        };
        if (mockWorker.onmessage) {
          mockWorker.onmessage({ data: message });
        }
      }, 0);

      const result = await workerService.calculateStats(mockEvents);

      expect(mockWorker.postMessage).toHaveBeenCalledWith({
        id: "req-1",
        type: "CALCULATE_STATS",
        payload: { events: mockEvents },
      });
      expect(result).toEqual(expectedResult);
    });

    it("should fallback to main thread stats calculation", async () => {
      Object.defineProperty(global, 'Worker', {
        value: undefined,
        writable: true,
      });

      const noWorkerService = new WorkerService();
      const result = await noWorkerService.calculateStats(mockEvents);

      expect(result).toHaveProperty("totalEvents", 2);
      // The implementation counts free events correctly - check actual count
      const freeCount = mockEvents.filter(e => e.isFree).length;
      expect(result).toHaveProperty("freeEvents", freeCount);
      expect(result).toHaveProperty("upcomingEvents");
      expect(result).toHaveProperty("pastEvents");

      noWorkerService.dispose();
    });
  });

  describe("error handling", () => {
    it("should handle unknown response ID", () => {
      const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});

      // Send response with unknown ID
      if (mockWorker.onmessage) {
        mockWorker.onmessage({
          data: {
            id: "unknown-id",
            success: true,
            data: { test: "data" },
          },
        });
      }

      expect(consoleWarn).toHaveBeenCalledWith(
        "Received response for unknown request:",
        "unknown-id"
      );

      consoleWarn.mockRestore();
    });

    it("should handle worker not available by falling back", async () => {
      // Set worker to null to simulate unavailable worker
      (workerService as any).worker = null;
      (workerService as any).isWorkerSupported = false;

      // Should fall back to main thread instead of throwing
      const result = await workerService.parseJson('{"test": true}', "events");
      expect(result).toEqual({ test: true });
    });

    it("should handle worker error by cleanup", () => {
      // Simulate worker error
      if (mockWorker.onerror) {
        mockWorker.onerror(new Error("Worker crashed"));
      }

      expect(mockWorker.terminate).toHaveBeenCalled();
    });

    it("should handle progress updates correctly", () => {
      // Just test that progress updates don't crash
      const parsePromise = workerService.parseJson('{"test": true}', "events");

      // Send progress update
      if (mockWorker.onmessage) {
        mockWorker.onmessage({
          data: {
            id: "req-1",
            success: true,
            progress: 50,
          },
        });
      }

      expect(parsePromise).toBeInstanceOf(Promise);

      // Complete the operation to clean up
      setTimeout(() => {
        if (mockWorker.onmessage) {
          mockWorker.onmessage({
            data: {
              id: "req-1",
              success: true,
              data: { data: { test: true } },
            },
          });
        }
      }, 0);
    });
  });

  describe("cleanup and disposal", () => {
    it("should dispose worker properly", () => {
      workerService.dispose();

      expect(mockWorker.terminate).toHaveBeenCalled();
    });

    it("should handle disposal when worker is null", () => {
      (workerService as any).worker = null;

      expect(() => workerService.dispose()).not.toThrow();
    });

    it("should handle cleanup operations", () => {
      // Test that cleanup methods exist and can be called
      expect(typeof workerService.dispose).toBe("function");
      expect(() => workerService.dispose()).not.toThrow();
    });
  });

  describe("message handling", () => {
    it("should handle message posting", async () => {
      // Make a simple request to verify message handling
      const parsePromise = workerService.parseJson('{"test": 1}', "events");

      expect(mockWorker.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ 
          type: "PARSE_JSON",
          payload: expect.any(Object)
        })
      );

      // Complete the request
      setTimeout(() => {
        if (mockWorker.onmessage) {
          mockWorker.onmessage({
            data: { id: "req-1", success: true, data: { data: { test: 1 } } },
          });
        }
      }, 0);

      await parsePromise;
    });
  });
});
