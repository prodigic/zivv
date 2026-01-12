/**
 * Test suite for FilterStore
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useFilterStore } from "@/stores/filterStore";
import type { EventFilters } from "@/types/events";

// Mock zustand devtools middleware
vi.mock("zustand/middleware", () => ({
  devtools: vi.fn((fn) => fn),
}));

describe("FilterStore", () => {
  let store: ReturnType<typeof useFilterStore>;

  beforeEach(() => {
    // Reset store state before each test
    store = useFilterStore.getState();
    store.clearFilters();
    store.clearSearch();
    store.setSortBy("date");
    store.setSortOrder("asc");
  });

  describe("initial state", () => {
    it("should have correct initial state", () => {
      const state = useFilterStore.getState();

      expect(state.filters).toEqual({
        cities: [],
        dates: [],
        venues: [],
        dateRange: {},
        priceRange: {},
        ageRestrictions: [],
        tags: [],
      });
      expect(state.searchQuery).toBe("");
      expect(state.sortBy).toBe("date");
      expect(state.sortOrder).toBe("asc");
      expect(state.hasActiveFilters).toBe(false);
      expect(state.activeFilterCount).toBe(0);
    });

    it("should have presets defined", () => {
      const state = useFilterStore.getState();

      expect(state.presets).toBeDefined();
      expect(state.presets.upcomingWeek).toBeDefined();
      expect(state.presets.thisWeekend).toBeDefined();
      expect(state.presets.nextMonth).toBeDefined();
      expect(state.presets.allAges).toBeDefined();
      expect(state.presets.freeShows).toBeDefined();
    });
  });

  describe("filter management", () => {
    it("should update single filter", () => {
      const { updateFilter } = useFilterStore.getState();

      updateFilter("cities", ["San Francisco", "Oakland"]);

      const state = useFilterStore.getState();
      expect(state.filters.cities).toEqual(["San Francisco", "Oakland"]);
      expect(state.hasActiveFilters).toBe(true);
      expect(state.activeFilterCount).toBe(1);
    });

    it("should update multiple filters", () => {
      const { setFilters } = useFilterStore.getState();

      const newFilters: Partial<EventFilters> = {
        cities: ["Berkeley"],
        dates: ["2024-01-15"],
        ageRestrictions: ["21+"],
      };

      setFilters(newFilters);

      const state = useFilterStore.getState();
      expect(state.filters.cities).toEqual(["Berkeley"]);
      expect(state.filters.dates).toEqual(["2024-01-15"]);
      expect(state.filters.ageRestrictions).toEqual(["21+"]);
      expect(state.hasActiveFilters).toBe(true);
      expect(state.activeFilterCount).toBe(3);
    });

    it("should clear specific filter", () => {
      const { updateFilter, clearFilter } = useFilterStore.getState();

      // Set multiple filters
      updateFilter("cities", ["San Francisco"]);
      updateFilter("dates", ["2024-01-15"]);

      expect(useFilterStore.getState().activeFilterCount).toBe(2);

      // Clear one filter
      clearFilter("cities");

      const state = useFilterStore.getState();
      expect(state.filters.cities).toEqual([]);
      expect(state.filters.dates).toEqual(["2024-01-15"]);
      expect(state.activeFilterCount).toBe(1);
    });

    it("should clear all filters", () => {
      const { updateFilter, clearFilters } = useFilterStore.getState();

      // Set multiple filters
      updateFilter("cities", ["San Francisco"]);
      updateFilter("dates", ["2024-01-15"]);
      updateFilter("venues", ["The Independent"]);

      expect(useFilterStore.getState().activeFilterCount).toBe(3);

      clearFilters();

      const state = useFilterStore.getState();
      expect(state.filters.cities).toEqual([]);
      expect(state.filters.dates).toEqual([]);
      expect(state.filters.venues).toEqual([]);
      expect(state.hasActiveFilters).toBe(false);
      expect(state.activeFilterCount).toBe(0);
    });

    it("should handle price range filters", () => {
      const { updateFilter } = useFilterStore.getState();

      updateFilter("priceRange", { min: 10, max: 50 });

      const state = useFilterStore.getState();
      expect(state.filters.priceRange).toEqual({ min: 10, max: 50 });
      expect(state.activeFilterCount).toBe(1);
    });

    it("should handle free shows filter", () => {
      const { setFilters } = useFilterStore.getState();

      setFilters({ isFree: true });

      const state = useFilterStore.getState();
      expect(state.filters.isFree).toBe(true);
      expect(state.activeFilterCount).toBe(1);
    });
  });

  describe("search functionality", () => {
    it("should update search query", () => {
      const { setSearchQuery } = useFilterStore.getState();

      setSearchQuery("punk rock show");

      const state = useFilterStore.getState();
      expect(state.searchQuery).toBe("punk rock show");
    });

    it("should clear search query", () => {
      const { setSearchQuery, clearSearch } = useFilterStore.getState();

      setSearchQuery("test query");
      expect(useFilterStore.getState().searchQuery).toBe("test query");

      clearSearch();
      expect(useFilterStore.getState().searchQuery).toBe("");
    });
  });

  describe("sorting functionality", () => {
    it("should update sort by", () => {
      const { setSortBy } = useFilterStore.getState();

      setSortBy("price");

      const state = useFilterStore.getState();
      expect(state.sortBy).toBe("price");
    });

    it("should update sort order", () => {
      const { setSortOrder } = useFilterStore.getState();

      setSortOrder("desc");

      const state = useFilterStore.getState();
      expect(state.sortOrder).toBe("desc");
    });

    it("should toggle sort order", () => {
      const { toggleSortOrder } = useFilterStore.getState();

      expect(useFilterStore.getState().sortOrder).toBe("asc");

      toggleSortOrder();
      expect(useFilterStore.getState().sortOrder).toBe("desc");

      toggleSortOrder();
      expect(useFilterStore.getState().sortOrder).toBe("asc");
    });
  });

  describe("presets", () => {
    it("should apply upcoming week preset", () => {
      const { applyPreset } = useFilterStore.getState();

      applyPreset("upcomingWeek");

      const state = useFilterStore.getState();
      expect(state.filters.dateRange).toBeDefined();
      expect(state.filters.dateRange.startDate).toBeDefined();
      expect(state.filters.dateRange.endDate).toBeDefined();
      expect(state.hasActiveFilters).toBe(true);
    });

    it("should apply all ages preset", () => {
      const { applyPreset } = useFilterStore.getState();

      applyPreset("allAges");

      const state = useFilterStore.getState();
      expect(state.filters.ageRestrictions).toEqual(["all-ages"]);
      expect(state.hasActiveFilters).toBe(true);
    });

    it("should apply free shows preset", () => {
      const { applyPreset } = useFilterStore.getState();

      applyPreset("freeShows");

      const state = useFilterStore.getState();
      expect(state.filters.isFree).toBe(true);
      expect(state.hasActiveFilters).toBe(true);
    });
  });

  describe("URL synchronization", () => {
    it("should sync to URL", () => {
      const { updateFilter, setSearchQuery, setSortBy, syncToURL } =
        useFilterStore.getState();

      updateFilter("cities", ["San Francisco", "Oakland"]);
      updateFilter("dates", ["2024-01-15"]);
      setSearchQuery("punk rock");
      setSortBy("price");

      const params = syncToURL();

      expect(params.get("cities")).toBe("San Francisco,Oakland");
      expect(params.get("dates")).toBe("2024-01-15");
      expect(params.get("q")).toBe("punk rock");
      expect(params.get("sortBy")).toBe("price");
    });

    it("should sync from URL", () => {
      const { syncFromURL } = useFilterStore.getState();

      const params = new URLSearchParams();
      params.set("cities", "Berkeley,Santa Cruz");
      params.set("dates", "2024-01-15,2024-01-16");
      params.set("q", "metal show");
      params.set("sortBy", "venue");
      params.set("sortOrder", "desc");
      params.set("isFree", "true");

      syncFromURL(params);

      const state = useFilterStore.getState();
      expect(state.filters.cities).toEqual(["Berkeley", "Santa Cruz"]);
      expect(state.filters.dates).toEqual(["2024-01-15", "2024-01-16"]);
      expect(state.searchQuery).toBe("metal show");
      expect(state.sortBy).toBe("venue");
      expect(state.sortOrder).toBe("desc");
      expect(state.filters.isFree).toBe(true);
    });

    it("should handle empty URL parameters", () => {
      const { syncFromURL } = useFilterStore.getState();

      const params = new URLSearchParams();
      syncFromURL(params);

      const state = useFilterStore.getState();
      expect(state.filters.cities).toEqual([]);
      expect(state.searchQuery).toBe("");
      expect(state.sortBy).toBe("date");
      expect(state.sortOrder).toBe("asc");
    });
  });

  describe("filter summary and active filters", () => {
    it("should generate correct filter summary for no filters", () => {
      const { getFilterSummary } = useFilterStore.getState();

      const summary = getFilterSummary();
      expect(summary).toBe("All Events");
    });

    it("should generate correct filter summary for single city", () => {
      const { updateFilter, getFilterSummary } = useFilterStore.getState();

      updateFilter("cities", ["San Francisco"]);

      const summary = getFilterSummary();
      expect(summary).toBe("in San Francisco");
    });

    it("should generate correct filter summary for multiple filters", () => {
      const { updateFilter, getFilterSummary } = useFilterStore.getState();

      updateFilter("cities", ["San Francisco", "Oakland"]);
      updateFilter("dates", ["2024-01-15"]);

      const summary = getFilterSummary();
      expect(summary).toContain("in 2 cities");
      expect(summary).toContain("on specific day");
    });

    it("should get active filters", () => {
      const { updateFilter, setFilters, getActiveFilters } =
        useFilterStore.getState();

      updateFilter("cities", ["Berkeley"]);
      updateFilter("venues", ["The Fillmore"]);
      setFilters({ isFree: true });

      const activeFilters = getActiveFilters();

      expect(activeFilters).toHaveLength(3);
      expect(activeFilters.find((f) => f.key === "cities")).toEqual({
        key: "cities",
        value: ["Berkeley"],
        label: "City: Berkeley",
      });
      expect(activeFilters.find((f) => f.key === "venues")).toEqual({
        key: "venues",
        value: ["The Fillmore"],
        label: "Venue: The Fillmore",
      });
      expect(activeFilters.find((f) => f.key === "isFree")).toEqual({
        key: "isFree",
        value: true,
        label: "Free shows only",
      });
    });
  });

  describe("edge cases", () => {
    it("should handle clearing non-existent filter", () => {
      const { clearFilter } = useFilterStore.getState();

      // Should not throw error
      expect(() => clearFilter("cities")).not.toThrow();
    });

    it("should handle invalid sort options in URL", () => {
      const { syncFromURL } = useFilterStore.getState();

      const params = new URLSearchParams();
      params.set("sortBy", "invalid");
      params.set("sortOrder", "invalid");

      syncFromURL(params);

      const state = useFilterStore.getState();
      expect(state.sortBy).toBe("date"); // Should remain default
      expect(state.sortOrder).toBe("asc"); // Should remain default
    });

    it("should handle malformed price range in URL", () => {
      const { syncFromURL } = useFilterStore.getState();

      const params = new URLSearchParams();
      params.set("minPrice", "not-a-number");
      params.set("maxPrice", "also-not-a-number");

      syncFromURL(params);

      const state = useFilterStore.getState();
      // The actual implementation sets NaN values for invalid numbers
      expect(state.filters.priceRange).toEqual({ min: NaN, max: NaN });
    });

    it("should handle empty filter arrays", () => {
      const { updateFilter } = useFilterStore.getState();

      updateFilter("cities", []);
      updateFilter("dates", []);

      const state = useFilterStore.getState();
      expect(state.hasActiveFilters).toBe(false);
      expect(state.activeFilterCount).toBe(0);
    });
  });
});
