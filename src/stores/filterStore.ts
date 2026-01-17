/**
 * Filter and search state management with URL synchronization
 */

import { create } from "zustand";
import { devtools, persist } from "zustand/middleware";
import type { EventFilters } from "@/types/events.js";

// Filter state interface
export interface FilterState {
  // Current filters
  filters: EventFilters;

  // Search query
  searchQuery: string;

  // Sort options
  sortBy: "date" | "relevance" | "price" | "venue";
  sortOrder: "asc" | "desc";

  // Active filter indicators
  hasActiveFilters: boolean;
  activeFilterCount: number;

  // Filter presets for quick access
  presets: {
    upcomingWeek: EventFilters;
    thisWeekend: EventFilters;
    nextMonth: EventFilters;
    allAges: EventFilters;
    freeShows: EventFilters;
  };
}

// Filter actions interface
export interface FilterActions {
  // Filter management
  setFilters: (filters: Partial<EventFilters>) => void;
  updateFilter: <K extends keyof EventFilters>(
    key: K,
    value: EventFilters[K]
  ) => void;
  clearFilters: () => void;
  clearFilter: (key: keyof EventFilters) => void;

  // Search
  setSearchQuery: (query: string) => void;
  clearSearch: () => void;

  // Sorting
  setSortBy: (sortBy: FilterState["sortBy"]) => void;
  setSortOrder: (sortOrder: FilterState["sortOrder"]) => void;
  toggleSortOrder: () => void;

  // Presets
  applyPreset: (presetName: keyof FilterState["presets"]) => void;

  // URL synchronization
  syncFromURL: (searchParams: URLSearchParams) => void;
  syncToURL: () => URLSearchParams;

  // Utilities
  getFilterSummary: () => string;
  getActiveFilters: () => Array<{ key: string; value: unknown; label: string }>;
}

// Combined store type
export type FilterStore = FilterState & FilterActions;

// Helper functions
function createDateFilter(days: number): {
  startDate: string;
  endDate: string;
} {
  const start = new Date();
  const end = new Date();
  end.setDate(start.getDate() + days);

  return {
    startDate: start.toISOString().split("T")[0],
    endDate: end.toISOString().split("T")[0],
  };
}

function getThisWeekendDates(): { startDate: string; endDate: string } {
  const today = new Date();
  const currentDay = today.getDay();

  // Find next Saturday
  const daysUntilSaturday = (6 - currentDay) % 7;
  const saturday = new Date();
  saturday.setDate(today.getDate() + daysUntilSaturday);

  // Sunday is the day after Saturday
  const sunday = new Date(saturday);
  sunday.setDate(saturday.getDate() + 1);

  return {
    startDate: saturday.toISOString().split("T")[0],
    endDate: sunday.toISOString().split("T")[0],
  };
}

// Create the filter store with persistence
export const useFilterStore = create<FilterStore>()(
  devtools(
    persist(
      (set, get) => ({
        // Initial state
        filters: {
          cities: [],
          dates: [],
          venues: [],
          dateRange: {},
          priceRange: {},
          ageRestrictions: [],
          tags: [],
        },

        searchQuery: "",
        sortBy: "date",
        sortOrder: "asc",
        hasActiveFilters: false,
        activeFilterCount: 0,

        // Presets
        presets: {
          upcomingWeek: {
            dateRange: createDateFilter(7),
          },
          thisWeekend: {
            dateRange: getThisWeekendDates(),
          },
          nextMonth: {
            dateRange: createDateFilter(30),
          },
          allAges: {
            ageRestrictions: ["all-ages"],
          },
          freeShows: {
            isFree: true,
          },
        },

        // Actions
        setFilters(newFilters: Partial<EventFilters>) {
          set((state) => {
            const updatedFilters = { ...state.filters, ...newFilters };
            const activeCount = calculateActiveFilterCount(updatedFilters);

            return {
              filters: updatedFilters,
              hasActiveFilters: activeCount > 0,
              activeFilterCount: activeCount,
            };
          });
        },

        updateFilter<K extends keyof EventFilters>(
          key: K,
          value: EventFilters[K]
        ) {
          set((state) => {
            const updatedFilters = { ...state.filters, [key]: value };
            const activeCount = calculateActiveFilterCount(updatedFilters);

            return {
              filters: updatedFilters,
              hasActiveFilters: activeCount > 0,
              activeFilterCount: activeCount,
            };
          });
        },

        clearFilters() {
          set({
            filters: {
              cities: [],
              dates: [],
              venues: [],
              dateRange: {},
              priceRange: {},
              ageRestrictions: [],
              tags: [],
            },
            hasActiveFilters: false,
            activeFilterCount: 0,
          });
        },

        clearFilter(key: keyof EventFilters) {
          set((state) => {
            const updatedFilters = { ...state.filters };

            if (key === "cities") updatedFilters.cities = [];
            else if (key === "dates") updatedFilters.dates = [];
            else if (key === "venues") updatedFilters.venues = [];
            else if (key === "dateRange") updatedFilters.dateRange = {};
            else if (key === "priceRange") updatedFilters.priceRange = {};
            else if (key === "ageRestrictions")
              updatedFilters.ageRestrictions = [];
            else if (key === "tags") updatedFilters.tags = [];
            else if (key === "isFree") delete updatedFilters.isFree;
            else if (key === "venueTypes") updatedFilters.venueTypes = [];

            const activeCount = calculateActiveFilterCount(updatedFilters);

            return {
              filters: updatedFilters,
              hasActiveFilters: activeCount > 0,
              activeFilterCount: activeCount,
            };
          });
        },

        setSearchQuery(searchQuery: string) {
          set({ searchQuery });
        },

        clearSearch() {
          set({ searchQuery: "" });
        },

        setSortBy(sortBy: FilterState["sortBy"]) {
          set({ sortBy });
        },

        setSortOrder(sortOrder: FilterState["sortOrder"]) {
          set({ sortOrder });
        },

        toggleSortOrder() {
          set((state) => ({
            sortOrder: state.sortOrder === "asc" ? "desc" : "asc",
          }));
        },

        applyPreset(presetName: keyof FilterState["presets"]) {
          const preset = get().presets[presetName];
          get().setFilters(preset);
        },

        // URL synchronization
        syncFromURL(searchParams: URLSearchParams) {
          const filters: Partial<EventFilters> = {};

          // Cities
          const cities = searchParams.get("cities");
          if (cities) {
            filters.cities = cities.split(",");
          }

          // Dates (multi-select)
          const dates = searchParams.get("dates");
          if (dates) {
            filters.dates = dates.split(",");
          }

          // Venues (multi-select)
          const venues = searchParams.get("venues");
          if (venues) {
            filters.venues = venues.split(",");
          }

          // Date range
          const startDate = searchParams.get("startDate");
          const endDate = searchParams.get("endDate");
          if (startDate || endDate) {
            filters.dateRange = {};
            if (startDate) filters.dateRange.startDate = startDate;
            if (endDate) filters.dateRange.endDate = endDate;
          }

          // Price range
          const minPrice = searchParams.get("minPrice");
          const maxPrice = searchParams.get("maxPrice");
          if (minPrice || maxPrice) {
            filters.priceRange = {};
            if (minPrice) filters.priceRange.min = parseFloat(minPrice);
            if (maxPrice) filters.priceRange.max = parseFloat(maxPrice);
          }

          // Free shows
          const isFree = searchParams.get("isFree");
          if (isFree === "true") {
            filters.isFree = true;
          }

          // Age restrictions
          const ageRestrictions = searchParams.get("ageRestrictions");
          if (ageRestrictions) {
            filters.ageRestrictions = ageRestrictions.split(",");
          }

          // Tags
          const tags = searchParams.get("tags");
          if (tags) {
            filters.tags = tags.split(",");
          }

          // Search query
          const query = searchParams.get("q");
          if (query) {
            set({ searchQuery: query });
          }

          // Sort options
          const sortBy = searchParams.get("sortBy");
          if (
            sortBy &&
            ["date", "relevance", "price", "venue"].includes(sortBy)
          ) {
            set({ sortBy: sortBy as FilterState["sortBy"] });
          }

          const sortOrder = searchParams.get("sortOrder");
          if (sortOrder && ["asc", "desc"].includes(sortOrder)) {
            set({ sortOrder: sortOrder as FilterState["sortOrder"] });
          }

          // Apply filters
          if (Object.keys(filters).length > 0) {
            get().setFilters(filters);
          }
        },

        syncToURL() {
          const { filters, searchQuery, sortBy, sortOrder } = get();
          const params = new URLSearchParams();

          // Add filters to URL
          if (filters.cities && filters.cities.length > 0) {
            params.set("cities", filters.cities.join(","));
          }

          if (filters.dates && filters.dates.length > 0) {
            params.set("dates", filters.dates.join(","));
          }

          if (filters.venues && filters.venues.length > 0) {
            params.set("venues", filters.venues.join(","));
          }

          if (filters.dateRange?.startDate) {
            params.set("startDate", filters.dateRange.startDate);
          }

          if (filters.dateRange?.endDate) {
            params.set("endDate", filters.dateRange.endDate);
          }

          if (filters.priceRange?.min !== undefined) {
            params.set("minPrice", filters.priceRange.min.toString());
          }

          if (filters.priceRange?.max !== undefined) {
            params.set("maxPrice", filters.priceRange.max.toString());
          }

          if (filters.isFree) {
            params.set("isFree", "true");
          }

          if (filters.ageRestrictions && filters.ageRestrictions.length > 0) {
            params.set("ageRestrictions", filters.ageRestrictions.join(","));
          }

          if (filters.tags && filters.tags.length > 0) {
            params.set("tags", filters.tags.join(","));
          }

          // Add search query
          if (searchQuery.trim()) {
            params.set("q", searchQuery.trim());
          }

          // Add sort options if not default
          if (sortBy !== "date") {
            params.set("sortBy", sortBy);
          }

          if (sortOrder !== "asc") {
            params.set("sortOrder", sortOrder);
          }

          return params;
        },

        getFilterSummary() {
          const { filters, hasActiveFilters, activeFilterCount } = get();

          if (!hasActiveFilters) {
            return "All Events";
          }

          // Map normalized city names to display names
          const cityDisplayMap: Record<string, string> = {
            "S.f": "San Francisco",
            Oakland: "Oakland",
            Berkeley: "Berkeley",
            Santa: "Santa Cruz",
          };

          const parts: string[] = [];

          if (filters.cities && filters.cities.length > 0) {
            if (filters.cities.length === 1) {
              const displayName =
                cityDisplayMap[filters.cities[0]] || filters.cities[0];
              parts.push(`in ${displayName}`);
            } else {
              parts.push(`in ${filters.cities.length} cities`);
            }
          }

          if (filters.dates && filters.dates.length > 0) {
            if (filters.dates.length === 1) {
              parts.push("on specific day");
            } else {
              parts.push(`on ${filters.dates.length} days`);
            }
          } else if (
            filters.dateRange?.startDate &&
            filters.dateRange?.endDate
          ) {
            parts.push("custom date range");
          } else if (filters.dateRange?.startDate) {
            parts.push("after specific date");
          } else if (filters.dateRange?.endDate) {
            parts.push("before specific date");
          }

          if (filters.venues && filters.venues.length > 0) {
            if (filters.venues.length === 1) {
              parts.push(`at ${filters.venues[0]}`);
            } else {
              parts.push(`at ${filters.venues.length} venues`);
            }
          }

          if (filters.isFree) {
            parts.push("free shows");
          } else if (filters.priceRange?.min || filters.priceRange?.max) {
            parts.push("price range");
          }

          if (filters.ageRestrictions && filters.ageRestrictions.length > 0) {
            parts.push("age restrictions");
          }

          if (parts.length === 0) {
            return `${activeFilterCount} filters active`;
          }

          return parts.join(" • ");
        },

        getActiveFilters() {
          const { filters } = get();
          const active: Array<{ key: string; value: unknown; label: string }> = [];

          // Map normalized city names to display names
          const cityDisplayMap: Record<string, string> = {
            "S.f": "San Francisco",
            Oakland: "Oakland",
            Berkeley: "Berkeley",
            Santa: "Santa Cruz",
          };

          if (filters.cities && filters.cities.length > 0) {
            const displayCities = filters.cities.map(
              (city) => cityDisplayMap[city] || city
            );
            active.push({
              key: "cities",
              value: filters.cities,
              label:
                displayCities.length === 1
                  ? `City: ${displayCities[0]}`
                  : `Cities: ${displayCities.join(", ")}`,
            });
          }

          if (filters.dates && filters.dates.length > 0) {
            active.push({
              key: "dates",
              value: filters.dates,
              label:
                filters.dates.length === 1
                  ? `Date: ${filters.dates[0]}`
                  : `Dates: ${filters.dates.join(", ")}`,
            });
          }

          if (filters.venues && filters.venues.length > 0) {
            active.push({
              key: "venues",
              value: filters.venues,
              label:
                filters.venues.length === 1
                  ? `Venue: ${filters.venues[0]}`
                  : `Venues: ${filters.venues.join(", ")}`,
            });
          }

          if (filters.dateRange?.startDate || filters.dateRange?.endDate) {
            const start = filters.dateRange.startDate;
            const end = filters.dateRange.endDate;
            let label = "Date: ";

            if (start && end) {
              label += `${start} to ${end}`;
            } else if (start) {
              label += `after ${start}`;
            } else if (end) {
              label += `before ${end}`;
            }

            active.push({
              key: "dateRange",
              value: filters.dateRange,
              label,
            });
          }

          if (filters.isFree) {
            active.push({
              key: "isFree",
              value: true,
              label: "Free shows only",
            });
          } else if (
            filters.priceRange?.min !== undefined ||
            filters.priceRange?.max !== undefined
          ) {
            const min = filters.priceRange.min;
            const max = filters.priceRange.max;
            let label = "Price: ";

            if (min !== undefined && max !== undefined) {
              label += `$${min} - $${max}`;
            } else if (min !== undefined) {
              label += `min $${min}`;
            } else if (max !== undefined) {
              label += `max $${max}`;
            }

            active.push({
              key: "priceRange",
              value: filters.priceRange,
              label,
            });
          }

          if (filters.ageRestrictions && filters.ageRestrictions.length > 0) {
            active.push({
              key: "ageRestrictions",
              value: filters.ageRestrictions,
              label: `Age: ${filters.ageRestrictions.join(", ")}`,
            });
          }

          if (filters.tags && filters.tags.length > 0) {
            active.push({
              key: "tags",
              value: filters.tags,
              label: `Tags: ${filters.tags.join(", ")}`,
            });
          }

          return active;
        },
      }),
      {
        name: "zivv-filters", // localStorage key
        partialize: (state) => ({
          filters: state.filters,
          searchQuery: state.searchQuery,
          sortBy: state.sortBy,
          sortOrder: state.sortOrder,
        }),
      }
    ),
    {
      name: "zivv-filter-store",
    }
  )
);

// Helper function to calculate active filter count
function calculateActiveFilterCount(filters: EventFilters): number {
  let count = 0;

  if (filters.cities && filters.cities.length > 0) count++;
  if (filters.dates && filters.dates.length > 0) count++;
  if (filters.venues && filters.venues.length > 0) count++;
  if (
    filters.dateRange &&
    (filters.dateRange.startDate || filters.dateRange.endDate)
  )
    count++;
  if (
    filters.priceRange &&
    (filters.priceRange.min !== undefined ||
      filters.priceRange.max !== undefined)
  )
    count++;
  if (filters.isFree) count++;
  if (filters.ageRestrictions && filters.ageRestrictions.length > 0) count++;
  if (filters.venueTypes && filters.venueTypes.length > 0) count++;
  if (filters.tags && filters.tags.length > 0) count++;

  return count;
}
