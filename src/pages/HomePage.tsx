/**
 * Home page - Event list with infinite scroll
 */

import React, { useEffect, useState, useCallback } from "react";
import { useLocation } from "react-router-dom";
import { ContentArea } from "@/components/layout/AppShell.tsx";
import { useAppStore } from "@/stores/appStore.ts";
import { useFilterStore } from "@/stores/filterStore.ts";
import {
  EventCardSkeleton,
  ListSkeleton,
} from "@/components/ui/LoadingSpinner.tsx";
import VirtualizedEventList from "@/components/ui/VirtualizedEventList.tsx";
import type { Event } from "@/types/events";

// City display name mapping
const getCityDisplayName = (cityName: string): string => {
  const cityMappings: Record<string, string> = {
    Santa: "Santa Cruz",
    "S.f": "San Francisco",
    Uc: "Berkeley", // UC Berkeley area
    San: "San Jose", // Partial city names
    "140": "San Francisco", // Venue address codes
    "2045": "San Francisco",
    "23": "Petaluma",
    "27826": "Unknown",
    Mountain: "Mountain View",
  };

  return cityMappings[cityName] || cityName;
};

const HomePage: React.FC = () => {
  const getAllEvents = useAppStore((state) => state.getAllEvents);
  const getVenue = useAppStore((state) => state.getVenue);
  const loading = useAppStore((state) => state.loading);
  const errors = useAppStore((state) => state.errors);
  const loadChunk = useAppStore((state) => state.loadChunk);
  const initialize = useAppStore((state) => state.initialize);
  const artists = useAppStore((state) => state.artists);
  const showUpcomingOnly = useAppStore((state) => state.showUpcomingOnly);
  const manifest = useAppStore((state) => state.manifest);

  const { filters, searchQuery } = useFilterStore();
  const getArtist = useAppStore((state) => state.getArtist);
  const location = useLocation();

  const [viewMode, setViewMode] = useState<"wide" | "narrow">("narrow");
  const [displayLimit, setDisplayLimit] = useState(50); // Start with 50 events
  const pageSize = 50; // Load 50 events at a time for infinite scroll
  const allEventsRaw = getAllEvents(Infinity); // Get all loaded events

  // Scroll position restoration - target the actual scrolling container (main element)
  useEffect(() => {
    const scrollKey = `scroll-position-home`;
    const savedPosition = sessionStorage.getItem(scrollKey);
    const mainElement = document.querySelector('main');
    
    if (savedPosition && mainElement) {
      // Restore scroll position after content loads
      const timeoutId = setTimeout(() => {
        if (mainElement) {
          mainElement.scrollTop = parseInt(savedPosition, 10);
        }
      }, 100);
      
      return () => clearTimeout(timeoutId);
    }
  }, [location.key]);

  // Save scroll position on unmount or navigation
  useEffect(() => {
    const scrollKey = `scroll-position-home`;
    const mainElement = document.querySelector('main');
    
    return () => {
      if (mainElement) {
        sessionStorage.setItem(
          scrollKey,
          mainElement.scrollTop.toString()
        );
      }
    };
  }, []);

  // Apply filters from filter store
  const { allFilteredEvents, allEvents } = React.useMemo(() => {
    let filteredEvents = allEventsRaw;

    // Apply upcoming filter
    if (showUpcomingOnly) {
      const today = new Date();
      today.setHours(0, 0, 0, 0); // Start of today
      const todayMs = today.getTime();
      filteredEvents = filteredEvents.filter(
        (event) => event.dateEpochMs >= todayMs
      );
    }

    // Apply city filter
    if (filters.cities && filters.cities.length > 0) {
      filteredEvents = filteredEvents.filter((event) => {
        const venue = getVenue(event.venueId);
        return venue && filters.cities.includes(venue.city);
      });
    }

    // Apply specific dates filter (multi-select dates)
    if (filters.dates && filters.dates.length > 0) {
      filteredEvents = filteredEvents.filter((event) => {
        const eventDate = new Date(event.dateEpochMs)
          .toISOString()
          .split("T")[0];
        return filters.dates.includes(eventDate);
      });
    }

    // Apply date range filter
    if (filters.dateRange?.startDate || filters.dateRange?.endDate) {
      filteredEvents = filteredEvents.filter((event) => {
        const eventDate = new Date(event.dateEpochMs);
        eventDate.setHours(0, 0, 0, 0);

        if (filters.dateRange.startDate) {
          const startDate = new Date(filters.dateRange.startDate);
          startDate.setHours(0, 0, 0, 0);
          if (eventDate < startDate) return false;
        }

        if (filters.dateRange.endDate) {
          const endDate = new Date(filters.dateRange.endDate);
          endDate.setHours(23, 59, 59, 999);
          if (eventDate > endDate) return false;
        }

        return true;
      });
    }

    // Apply venue filter
    if (filters.venues && filters.venues.length > 0) {
      filteredEvents = filteredEvents.filter((event) => {
        const venue = getVenue(event.venueId);
        return venue && filters.venues.includes(venue.name);
      });
    }

    // Apply price range filter
    if (filters.isFree) {
      filteredEvents = filteredEvents.filter((event) => event.isFree === true);
    } else if (
      filters.priceRange?.min !== undefined ||
      filters.priceRange?.max !== undefined
    ) {
      filteredEvents = filteredEvents.filter((event) => {
        // Handle free events
        if (event.isFree) {
          return (
            filters.priceRange.min === undefined || filters.priceRange.min === 0
          );
        }

        const eventPrice = event.priceMin || 0;

        if (
          filters.priceRange.min !== undefined &&
          eventPrice < filters.priceRange.min
        ) {
          return false;
        }

        if (
          filters.priceRange.max !== undefined &&
          eventPrice > filters.priceRange.max
        ) {
          return false;
        }

        return true;
      });
    }

    // Apply age restriction filter
    if (filters.ageRestrictions && filters.ageRestrictions.length > 0) {
      filteredEvents = filteredEvents.filter((event) => {
        return filters.ageRestrictions.some((restriction) => {
          const eventAge = event.ageRestriction?.toLowerCase() || "";
          const filterAge = restriction.toLowerCase();

          // Handle "all-ages" variations
          if (filterAge === "all-ages" || filterAge === "all ages") {
            return (
              eventAge.includes("all") ||
              eventAge.includes("a/a") ||
              eventAge === "all-ages"
            );
          }

          // Handle specific age restrictions (18+, 21+, etc.)
          return eventAge.includes(filterAge);
        });
      });
    }

    // Apply tags filter
    if (filters.tags && filters.tags.length > 0) {
      filteredEvents = filteredEvents.filter((event) => {
        if (!event.tags || event.tags.length === 0) return false;
        return filters.tags.some((tag) => event.tags?.includes(tag));
      });
    }

    // Apply search query filter (search across artist names and venue names)
    if (searchQuery && searchQuery.trim().length > 0) {
      const searchLower = searchQuery.toLowerCase().trim();
      filteredEvents = filteredEvents.filter((event) => {
        // Search in headliner artist name
        const headlinerArtist = getArtist(event.headlinerArtistId);
        if (headlinerArtist?.name.toLowerCase().includes(searchLower)) {
          return true;
        }

        // Search in supporting artist names
        if (event.artistIds && event.artistIds.length > 0) {
          const hasMatchingArtist = event.artistIds.some((artistId) => {
            const artist = getArtist(artistId);
            return artist?.name.toLowerCase().includes(searchLower);
          });
          if (hasMatchingArtist) return true;
        }

        // Search in venue name
        const venue = getVenue(event.venueId);
        if (venue?.name.toLowerCase().includes(searchLower)) {
          return true;
        }

        return false;
      });
    }

    // Return both full filtered count and display-limited events
    return {
      allFilteredEvents: filteredEvents, // Full count of filtered events
      allEvents: filteredEvents.slice(0, displayLimit), // Display-limited events
    };
  }, [
    allEventsRaw,
    showUpcomingOnly,
    filters.dates,
    filters.dateRange,
    filters.priceRange,
    filters.cities,
    filters.venues,
    filters.isFree,
    filters.ageRestrictions,
    filters.tags,
    searchQuery,
    displayLimit,
    getVenue,
    getArtist,
  ]);

  useEffect(() => {
    const initializeAndLoadEvents = async () => {
      try {
        // Initialize the app store first if needed
        if (
          artists.size === 0 &&
          loading.artists === "idle" &&
          !errors.artists
        ) {
          await initialize();
        }

        // Load event chunks dynamically based on available data
        if (manifest?.chunks?.events) {
          // Load first 6 months of available chunks for better initial experience
          const availableChunks = manifest.chunks.events
            .map((chunk) => chunk.chunkId)
            .slice(0, 6); // Load first 6 months

          console.log("Loading event chunks:", availableChunks);
          await Promise.all(
            availableChunks.map((chunkId) => loadChunk(chunkId))
          );
        } else {
          // Fallback to known working chunks if manifest not available
          console.log("Manifest not available, using fallback chunks");
          await Promise.all([
            loadChunk("2025-09"),
            loadChunk("2025-10"),
            loadChunk("2025-11"),
          ]);
        }
      } catch (error) {
        console.error("Failed to initialize HomePage:", error);
      }
    };

    // Initialize if we need artists OR if we need events
    const needsArtists =
      artists.size === 0 && loading.artists === "idle" && !errors.artists;
    const needsEvents =
      allEvents.length === 0 && loading.events === "idle" && !errors.events;

    if (needsArtists || needsEvents) {
      initializeAndLoadEvents();
    }
  }, [
    allEvents.length,
    loading.events,
    errors.events,
    artists.size,
    loading.artists,
    errors.artists,
    loadChunk,
    initialize,
    manifest,
  ]);

  // Handle infinite scroll - load more events when reaching end
  const handleEndReached = useCallback(async () => {
    if (loading.events === "loading") return;

    const currentFilteredTotal = allFilteredEvents.length;

    // If we're showing all filtered events already
    if (displayLimit >= currentFilteredTotal) {
      // Check if we need to load more chunks
      const allAvailableEvents = allEventsRaw.length;

      if (allAvailableEvents > currentFilteredTotal) {
        // There are more events available in loaded chunks, just increase display limit
        setDisplayLimit((prev) => prev + pageSize);
      } else {
        // Need to load more chunks from server
        const lastEvent = allEventsRaw[allEventsRaw.length - 1];
        if (lastEvent) {
          const lastEventDate = new Date(lastEvent.dateEpochMs);
          const nextMonth = new Date(lastEventDate);
          nextMonth.setMonth(nextMonth.getMonth() + 1);

          const year = nextMonth.getFullYear();
          const month = nextMonth.getMonth() + 1;
          const yearMonth = `${year}-${month.toString().padStart(2, "0")}`;

          console.log("Loading next chunk:", yearMonth);
          await loadChunk(yearMonth);
          setDisplayLimit((prev) => prev + pageSize);
        }
      }
    } else {
      // We have more filtered events to show, increase limit
      setDisplayLimit((prev) =>
        Math.min(prev + pageSize, currentFilteredTotal)
      );
    }
  }, [
    loading.events,
    allFilteredEvents.length,
    displayLimit,
    allEventsRaw,
    pageSize,
    loadChunk,
  ]);

  if (loading.events === "loading" && allEvents.length === 0) {
    return (
      <ContentArea>
        <div className="space-y-6">
          <div className="flex flex-col space-y-4">
            <div className="h-8 bg-gray-200 rounded animate-pulse w-48"></div>
            <div className="h-4 bg-gray-200 rounded animate-pulse w-64"></div>
          </div>
          <ListSkeleton count={6} itemSkeleton={EventCardSkeleton} />
        </div>
      </ContentArea>
    );
  }

  if (errors.events) {
    return (
      <ContentArea>
        <div className="text-center py-12">
          <div className="text-red-600 mb-4">
            <svg
              className="w-12 h-12 mx-auto mb-4"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z"
              />
            </svg>
          </div>
          <h3 className="text-lg font-semibold text-gray-900 mb-2">
            Unable to load events
          </h3>
          <p className="text-gray-600 mb-4">{errors.events}</p>
          <button
            onClick={() => {
              // Try to reload the first available chunk or fallback
              const firstChunk =
                manifest?.chunks?.events?.[0]?.chunkId || "2025-09";
              loadChunk(firstChunk);
            }}
            className="px-4 py-2 bg-primary-600 text-white rounded-lg hover:bg-primary-700 transition-colors"
          >
            Try Again
          </button>
        </div>
      </ContentArea>
    );
  }

  return (
    <ContentArea className="h-full">
      <div className="flex flex-col h-full space-y-6">
        {/* Header */}
        <div className="flex flex-col space-y-4">
          <div className="flex items-start justify-between">
            <div className="flex-1">
              <h1 className="text-3xl font-bold text-gray-900 dark:text-white mb-2">
                {(() => {
                  // Calculate total unfiltered events based on showUpcomingOnly setting
                  let baseEvents = getAllEvents(Infinity);
                  if (showUpcomingOnly) {
                    const today = new Date();
                    today.setHours(0, 0, 0, 0); // Start of today
                    const todayMs = today.getTime();
                    baseEvents = baseEvents.filter(
                      (event) => event.dateEpochMs >= todayMs
                    );
                  }
                  const totalUnfilteredEvents = baseEvents.length;

                  const hasActiveFilters =
                    filters.cities?.length > 0 ||
                    filters.dates?.length > 0 ||
                    filters.dateRange?.startDate ||
                    filters.dateRange?.endDate ||
                    filters.priceRange?.min !== undefined ||
                    filters.priceRange?.max !== undefined ||
                    filters.isFree ||
                    !showUpcomingOnly;

                  if (
                    hasActiveFilters &&
                    allFilteredEvents.length !== totalUnfilteredEvents
                  ) {
                    return (
                      <>
                        Upcoming Shows{" "}
                        <span className="text-sm text-gray-500 font-normal">
                          ({allFilteredEvents.length} selected)
                        </span>
                      </>
                    );
                  } else {
                    return "Upcoming Shows";
                  }
                })()}
              </h1>
              <p className="text-gray-600 dark:text-gray-300">
                Bay Area punk and alternative shows
              </p>
            </div>
            <div className="flex items-center gap-3 ml-4">
              <div className="text-sm text-gray-500">
                {allFilteredEvents.length} events
              </div>

              {/* View Mode Toggle */}
              <div className="flex items-center gap-1 ml-3">
                <button
                  onClick={() => setViewMode("wide")}
                  className={`p-2 rounded ${
                    viewMode === "wide"
                      ? "bg-blue-500 text-white"
                      : "bg-gray-200 dark:bg-gray-700 text-gray-600 dark:text-gray-400 hover:bg-gray-300 dark:hover:bg-gray-600"
                  }`}
                  title="Wide view"
                >
                  <svg
                    className="w-4 h-4"
                    fill="currentColor"
                    viewBox="0 0 20 20"
                  >
                    <path d="M3 4a1 1 0 011-1h12a1 1 0 011 1v2a1 1 0 01-1 1H4a1 1 0 01-1-1V4zM3 10a1 1 0 011-1h12a1 1 0 011 1v2a1 1 0 01-1 1H4a1 1 0 01-1-1v-2zM3 16a1 1 0 011-1h12a1 1 0 011 1v2a1 1 0 01-1 1H4a1 1 0 01-1-1v-2z" />
                  </svg>
                </button>
                <button
                  onClick={() => setViewMode("narrow")}
                  className={`p-2 rounded ${
                    viewMode === "narrow"
                      ? "bg-blue-500 text-white"
                      : "bg-gray-200 dark:bg-gray-700 text-gray-600 dark:text-gray-400 hover:bg-gray-300 dark:hover:bg-gray-600"
                  }`}
                  title="Narrow view"
                >
                  <svg
                    className="w-4 h-4"
                    fill="currentColor"
                    viewBox="0 0 20 20"
                  >
                    <path d="M2 6a2 2 0 012-2h5l2 2h5a2 2 0 012 2v6a2 2 0 01-2 2H4a2 2 0 01-2-2V6z" />
                    <path d="M6 8a2 2 0 012-2h4a2 2 0 012 2v4a2 2 0 01-2 2H8a2 2 0 01-2-2V8z" />
                  </svg>
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* Debug info */}
        <div className="debug-info mb-4 space-y-1 p-3 bg-gray-100 dark:bg-gray-900 text-gray-900 dark:text-gray-100 font-mono text-xs border-2 border-gray-300 dark:border-gray-600 rounded">
          <div className="debug-label text-blue-700 dark:text-blue-300 font-bold">
            HomePage Debug Info:
          </div>
          <div>
            <span className="text-blue-700 dark:text-blue-300 font-bold">
              Events filtered/shown:
            </span>{" "}
            {allFilteredEvents.length}/{allEvents.length}
          </div>
          <div>
            <span className="text-blue-700 dark:text-blue-300 font-bold">
              Artists loaded:
            </span>{" "}
            {artists.size}
          </div>
          <div>
            <span className="text-blue-700 dark:text-blue-300 font-bold">
              Loading states:
            </span>{" "}
            artists={loading.artists}, events={loading.events}
          </div>
          <div>
            <span className="text-blue-700 dark:text-blue-300 font-bold">
              Errors:
            </span>{" "}
            artists={errors.artists}, events={errors.events}
          </div>
          <div>
            <span className="text-blue-700 dark:text-blue-300 font-bold">
              Search query:
            </span>{" "}
            "{searchQuery}"
          </div>
          <div>
            <span className="text-blue-700 dark:text-blue-300 font-bold">
              Active city filters:
            </span>{" "}
            {Object.keys(filters.cities || {}).length}
          </div>
          <div>
            <span className="text-blue-700 dark:text-blue-300 font-bold">
              Filter details:
            </span>{" "}
            {JSON.stringify({ ...filters, showUpcomingOnly })}
          </div>
        </div>

        {/* Event List - Virtualized */}
        <div
          style={{
            flex: 1,
            minHeight: 0,
            display: "flex",
            flexDirection: "column",
            overflow: "hidden",
          }}
        >
          <VirtualizedEventList
            events={allEvents}
            isLoading={loading.events === "loading"}
            viewMode={viewMode}
            onEndReached={handleEndReached}
            hasMore={
              displayLimit < allFilteredEvents.length ||
              allEventsRaw.length > allFilteredEvents.length
            }
          />
        </div>
      </div>
    </ContentArea>
  );
};

export default HomePage;
