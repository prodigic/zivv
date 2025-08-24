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

// @ts-ignore
global.indexedDB = mockIndexedDB;

describe("Phase 4: Application Shell & Routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("Router Configuration", () => {
    it("should render home page at root route", async () => {
      const testRouter = createMemoryRouter(
        router.routes,
        {
          initialEntries: ["/"],
          basename: router.basename,
        }
      );

      render(<RouterProvider router={testRouter} />);

      await waitFor(() => {
        expect(screen.getByText(/upcoming shows/i)).toBeInTheDocument();
      }, { timeout: 5000 });
    });

    it("should render calendar page", async () => {
      const testRouter = createMemoryRouter(
        router.routes,
        {
          initialEntries: ["/calendar/month"],
          basename: router.basename,
        }
      );

      render(<RouterProvider router={testRouter} />);

      await waitFor(() => {
        expect(screen.getByText(/calendar.*month view/i)).toBeInTheDocument();
      });
    });

    it("should render artists page", async () => {
      const testRouter = createMemoryRouter(
        router.routes,
        {
          initialEntries: ["/artists"],
          basename: router.basename,
        }
      );

      render(<RouterProvider router={testRouter} />);

      await waitFor(() => {
        expect(screen.getByText(/artists/i)).toBeInTheDocument();
      });
    });

    it("should render venues page", async () => {
      const testRouter = createMemoryRouter(
        router.routes,
        {
          initialEntries: ["/venues"],
          basename: router.basename,
        }
      );

      render(<RouterProvider router={testRouter} />);

      await waitFor(() => {
        expect(screen.getByText(/venues/i)).toBeInTheDocument();
      });
    });

    it("should render 404 page for unknown routes", async () => {
      const testRouter = createMemoryRouter(
        router.routes,
        {
          initialEntries: ["/unknown-route"],
          basename: router.basename,
        }
      );

      render(<RouterProvider router={testRouter} />);

      await waitFor(() => {
        expect(screen.getByText(/404/)).toBeInTheDocument();
        expect(screen.getByText(/page not found/i)).toBeInTheDocument();
      });
    });
  });

  describe("Navigation", () => {
    it("should render header with search", async () => {
      const testRouter = createMemoryRouter(
        router.routes,
        {
          initialEntries: ["/"],
          basename: router.basename,
        }
      );

      render(<RouterProvider router={testRouter} />);

      await waitFor(() => {
        expect(screen.getByPlaceholderText(/search artists, venues/i)).toBeInTheDocument();
        expect(screen.getByText("Zivv")).toBeInTheDocument();
      });
    });

    it("should render bottom navigation on mobile", async () => {
      const testRouter = createMemoryRouter(
        router.routes,
        {
          initialEntries: ["/"],
          basename: router.basename,
        }
      );

      render(<RouterProvider router={testRouter} />);

      await waitFor(() => {
        // Navigation items should be present
        expect(screen.getByText("Home")).toBeInTheDocument();
        expect(screen.getByText("Calendar")).toBeInTheDocument();
        expect(screen.getByText("Artists")).toBeInTheDocument();
        expect(screen.getByText("Venues")).toBeInTheDocument();
      });
    });
  });

  describe("Error Boundary", () => {
    it("should catch and display errors", async () => {
      // Create a component that throws an error
      const ThrowError = () => {
        throw new Error("Test error");
      };

      const testRouter = createMemoryRouter([
        {
          path: "/",
          element: <ThrowError />,
          errorElement: <div>Error caught by boundary</div>,
        },
      ]);

      render(<RouterProvider router={testRouter} />);

      await waitFor(() => {
        expect(screen.getByText("Error caught by boundary")).toBeInTheDocument();
      });
    });
  });

  describe("Loading States", () => {
    it("should show loading spinner initially", () => {
      const testRouter = createMemoryRouter(
        router.routes,
        {
          initialEntries: ["/"],
          basename: router.basename,
        }
      );

      render(<RouterProvider router={testRouter} />);

      // Should show loading initially
      expect(screen.getByText(/loading/i)).toBeInTheDocument();
    });
  });

  describe("Responsive Layout", () => {
    it("should render mobile layout components", async () => {
      const testRouter = createMemoryRouter(
        router.routes,
        {
          initialEntries: ["/"],
          basename: router.basename,
        }
      );

      render(<RouterProvider router={testRouter} />);

      await waitFor(() => {
        // Mobile-specific elements should be present
        expect(screen.getByLabelText("Open menu")).toBeInTheDocument();
      });
    });
  });
});