/**
 * Home page - Event list with infinite scroll
 */

import React, { useEffect } from "react";
import { ContentArea } from "@/components/layout/AppShell.tsx";
import { useAppStore } from "@/stores/appStore.ts";
import { useFilterStore } from "@/stores/filterStore.ts";
import {
  EventCardSkeleton,
  ListSkeleton,
} from "@/components/ui/LoadingSpinner.tsx";
import { DatePagination } from "@/components/ui/DatePagination.tsx";
import { CityPagination } from "@/components/ui/CityPagination.tsx";
import { VenueFilter } from "@/components/ui/VenueFilter.tsx";
import { PageSizeSelector } from "@/components/ui/PageSizeSelector.tsx";
import type { Event, Artist, ArtistId } from "@/types/events";

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

  const [pageSize, setPageSize] = React.useState(25);
  const [viewMode, setViewMode] = React.useState<"wide" | "narrow">("wide");
  const allEventsRaw = getAllEvents(Infinity); // Get all loaded events

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

    // Apply multi-select dates filter (from DatePagination)
    if (filters.dates && filters.dates.length > 0) {
      filteredEvents = filteredEvents.filter((event) => {
        const eventDateString = new Date(event.dateEpochMs)
          .toISOString()
          .split("T")[0];
        return filters.dates!.includes(eventDateString);
      });
    }

    // Apply legacy date range filter (for backward compatibility)
    if (
      filters.dateRange &&
      filters.dateRange.startDate &&
      filters.dateRange.endDate
    ) {
      const startMs = new Date(filters.dateRange.startDate).getTime();
      const endMs =
        new Date(filters.dateRange.endDate).getTime() + 24 * 60 * 60 * 1000 - 1; // End of day
      filteredEvents = filteredEvents.filter(
        (event) => event.dateEpochMs >= startMs && event.dateEpochMs <= endMs
      );
    }

    // Apply price filter (for free shows toggle)
    if (filters.priceRange && filters.priceRange.max !== undefined) {
      if (filters.priceRange.max === 0) {
        // Show only free events
        filteredEvents = filteredEvents.filter((event) => event.isFree);
      } else {
        // Show events within price range
        filteredEvents = filteredEvents.filter((event) => {
          if (event.isFree) return filters.priceRange!.min === 0;
          const eventPrice = event.priceMax || event.priceMin || 0;
          return (
            eventPrice >= (filters.priceRange!.min || 0) &&
            eventPrice <= (filters.priceRange!.max || Infinity)
          );
        });
      }
    }

    // Apply city filter (from CityPagination)
    if (filters.cities && filters.cities.length > 0) {
      filteredEvents = filteredEvents.filter((event) => {
        const venue = event.venueId ? getVenue(event.venueId) : null;
        if (!venue) return false;

        // Map full city names to normalized names for venue matching
        const cityMapping: Record<string, string> = {
          "San Francisco": "S.f",
          Oakland: "Oakland",
          Berkeley: "Berkeley",
          "Santa Cruz": "Santa",
        };

        // Check if venue city matches any selected cities
        return filters.cities!.some((selectedCity) => {
          const normalizedCity = cityMapping[selectedCity] || selectedCity;
          return venue.city === normalizedCity;
        });
      });
    }

    // Apply venue filter (from VenueFilter)
    if (filters.venues && filters.venues.length > 0) {
      filteredEvents = filteredEvents.filter((event) => {
        const venue = event.venueId ? getVenue(event.venueId) : null;
        if (!venue) return false;

        // Check if venue name matches any selected venues
        return filters.venues!.includes(venue.name);
      });
    }

    // Return both full filtered count and display-limited events
    return {
      allFilteredEvents: filteredEvents, // Full count of filtered events
      allEvents: filteredEvents.slice(0, pageSize), // Display-limited events
    };
  }, [
    allEventsRaw,
    showUpcomingOnly,
    filters.dates,
    filters.dateRange,
    filters.priceRange,
    filters.cities,
    filters.venues,
    pageSize,
    getVenue,
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
            .map(chunk => chunk.chunkId)
            .slice(0, 6); // Load first 6 months
          
          console.log('Loading event chunks:', availableChunks);
          await Promise.all(
            availableChunks.map(chunkId => loadChunk(chunkId))
          );
        } else {
          // Fallback to known working chunks if manifest not available
          console.log('Manifest not available, using fallback chunks');
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
            onClick={() => loadChunk("2025-08")}
            className="px-4 py-2 bg-primary-600 text-white rounded-lg hover:bg-primary-700 transition-colors"
          >
            Try Again
          </button>
        </div>
      </ContentArea>
    );
  }

  return (
    <ContentArea>
      <div className="space-y-6">
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
              <PageSizeSelector
                value={pageSize}
                onChange={setPageSize}
                className="flex-shrink-0"
              />

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

          {/* Date Pagination Navigation */}
          <DatePagination className="mt-4" />

          {/* City Pagination Navigation */}
          <CityPagination className="mt-4" />

          {/* Venue Filter */}
          <VenueFilter className="mt-4" />
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

        {/* Event List */}
        {allEvents.length === 0 ? (
          <div className="text-center py-12">
            <div className="text-gray-400 mb-4">
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
                  d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10"
                />
              </svg>
            </div>
            <h3 className="text-lg font-semibold text-gray-900 mb-2">
              No events found
            </h3>
            <p className="text-gray-600">
              {searchQuery || Object.keys(filters.cities || {}).length > 0
                ? "Try adjusting your search or filters"
                : "Check back soon for upcoming shows"}
            </p>
          </div>
        ) : (
          <div
            className={
              viewMode === "narrow"
                ? "flex flex-wrap gap-4 justify-start items-center"
                : "space-y-4"
            }
          >
            {allEvents.map((event, index) => (
              <EventCard
                key={event.id}
                event={event}
                index={index}
                viewMode={viewMode}
              />
            ))}

            {/* Load More Button - Only show if there are more filtered events to display */}
            {allFilteredEvents.length > pageSize && (
              <div className="text-center pt-6">
                <button
                  onClick={async () => {
                    const currentFilteredTotal = allEventsRaw.length;
                    const allAvailableEvents = getAllEvents(Infinity);

                    // First try to show more from already loaded events
                    if (pageSize < currentFilteredTotal) {
                      // Increase page size to show more events
                      const newPageSize = Math.min(
                        pageSize + pageSize,
                        currentFilteredTotal
                      );
                      setPageSize(newPageSize);
                    } else if (pageSize < allAvailableEvents.length) {
                      // Show more from all available events (different filters might have hidden some)
                      const newPageSize = Math.min(
                        pageSize + pageSize,
                        allAvailableEvents.length
                      );
                      setPageSize(newPageSize);
                    } else {
                      // Need to load more chunks from server
                      const lastEvent =
                        allAvailableEvents[allAvailableEvents.length - 1];
                      if (lastEvent) {
                        const lastEventDate = new Date(lastEvent.dateEpochMs);
                        const nextMonth = new Date(lastEventDate);
                        nextMonth.setMonth(nextMonth.getMonth() + 1);

                        const year = nextMonth.getFullYear();
                        const month = nextMonth.getMonth() + 1;
                        const yearMonth = `${year}-${month.toString().padStart(2, "0")}`;

                        console.log("Loading next chunk:", yearMonth);
                        await loadChunk(yearMonth);
                        setPageSize((prev) => prev + pageSize);
                      }
                    }
                  }}
                  disabled={loading.events === "loading"}
                  className="px-6 py-3 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded-lg text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  {loading.events === "loading" ? (
                    <div className="flex items-center space-x-2">
                      <div className="w-4 h-4 border-2 border-gray-400 border-t-transparent rounded-full animate-spin"></div>
                      <span>Loading...</span>
                    </div>
                  ) : (
                    "Load More Events"
                  )}
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </ContentArea>
  );
};

// Event Card Component
const EventCard: React.FC<{
  event: Event;
  index?: number;
  viewMode?: "wide" | "narrow";
}> = ({ event, index, viewMode = "wide" }) => {
  const getArtist = useAppStore((state) => state.getArtist);
  const getVenue = useAppStore((state) => state.getVenue);

  const formatDate = (epochMs: number) => {
    const date = new Date(epochMs);
    return date.toLocaleDateString("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  };

  const formatTime = (epochMs: number) => {
    const date = new Date(epochMs);
    return date.toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
    });
  };

  // Get venue details
  const venue = event.venueId ? getVenue(event.venueId) : null;

  // Get artist details
  const artists = event.artistIds
    ? event.artistIds
        .map((id: ArtistId) => getArtist(id))
        .filter(
          (artist: Artist | null) => artist !== null && artist !== undefined
        )
    : [];
  const headlinerArtist = event.headlinerArtistId
    ? getArtist(event.headlinerArtistId)
    : null;

  // Note: isPastEvent logic available if needed later
  // const isPastEvent = event.dateEpochMs < Date.now();

  // Generate variant colors based on event ID
  const colorVariants = [
    {
      bg: "linear-gradient(45deg, #fef3c7 0%, #fed7aa 100%)",
      border: "#d97706",
      header: "#d97706",
    }, // Orange
    {
      bg: "linear-gradient(45deg, #ddd6fe 0%, #c7d2fe 100%)",
      border: "#7c3aed",
      header: "#7c3aed",
    }, // Purple
    {
      bg: "linear-gradient(45deg, #fecaca 0%, #fed7d7 100%)",
      border: "#dc2626",
      header: "#dc2626",
    }, // Red
    {
      bg: "linear-gradient(45deg, #bbf7d0 0%, #d1fae5 100%)",
      border: "#059669",
      header: "#059669",
    }, // Green
    {
      bg: "linear-gradient(45deg, #bfdbfe 0%, #dbeafe 100%)",
      border: "#2563eb",
      header: "#2563eb",
    }, // Blue
    {
      bg: "linear-gradient(45deg, #fde68a 0%, #fef3c7 100%)",
      border: "#d97706",
      header: "#d97706",
    }, // Yellow
  ];

  const colorIndex = Math.abs(event.id) % colorVariants.length;
  const colors = colorVariants[colorIndex];

  // Create background text pattern
  const backgroundText = `${headlinerArtist?.name || "PUNK SHOW"} • ${venue?.name || "VENUE"} • `;

  // Generate random rotation between -1 and 1 degrees
  const randomRotation = (Math.random() - 0.5) * 2; // -1 to +1 degrees

  return (
    <div
      className={`mb-8 ${viewMode === "narrow" ? "w-full max-w-[250px]" : ""}`}
    >
      <div
        className={`relative border-2 border-dashed rounded-none shadow-lg transition-transform duration-200 overflow-hidden ${
          viewMode === "narrow" ? "text-xs" : ""
        }`}
        style={{
          background: colors.bg,
          borderLeft: `8px solid ${colors.border}`,
          borderRight: `8px solid ${colors.border}`,
          borderColor: colors.border,
          fontFamily: "monospace",
          transform: `rotate(${randomRotation}deg)`,
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.transform = `rotate(${randomRotation}deg) scale(1.05)`;
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.transform = `rotate(${randomRotation}deg)`;
        }}
      >
        {/* Background Pattern */}
        <div
          className="absolute inset-0 pointer-events-none select-none"
          style={{
            fontSize: "2rem",
            fontWeight: "bold",
            color: "rgba(0,0,0,0.05)",
            transform: "rotate(25deg) translateX(-20%) translateY(-20%)",
            lineHeight: "2.5rem",
            whiteSpace: "nowrap",
            overflow: "hidden",
            display: "flex",
            flexDirection: "column",
            gap: "0.5rem",
            width: "200%",
            height: "200%",
          }}
        >
          {Array.from({ length: 15 }, (_, i) => (
            <div
              key={i}
              style={{ transform: `translateX(${(i % 2) * -50}px)` }}
            >
              {backgroundText.repeat(10)}
            </div>
          ))}
        </div>

        {/* Ticket Header */}
        <div
          className="text-white text-center py-2 text-xs font-bold tracking-wider border-b-2 border-dashed"
          style={{
            backgroundColor: colors.header,
            borderColor: colors.border,
          }}
        >
          {viewMode === "narrow" ? (
            <>
              {formatDate(event.dateEpochMs)}
              {event.startTimeEpochMs && (
                <> • {formatTime(event.startTimeEpochMs)}</>
              )}
            </>
          ) : (
            "✦ PUNK ROCK SHOW TICKET ✦"
          )}
        </div>

        {/* Main Content - Full Width */}
        <div className="p-6">
          {/* Main Artist Name - Full Width */}
          <h2
            className={`font-bold text-gray-900 mb-3 tracking-tight ${
              viewMode === "narrow" ? "text-lg" : "text-2xl"
            }`}
            style={{ textShadow: "1px 1px 0px rgba(0,0,0,0.1)" }}
          >
            {headlinerArtist?.name || `Event ${event.id}`}
          </h2>

          {/* Date/Time Info (Wide View Only) */}
          {viewMode !== "narrow" && (
            <div className="space-y-1 text-sm text-gray-700 mb-3">
              <div className="flex items-center">
                <span className="font-bold w-12">DATE:</span>
                <span className="font-mono">
                  {formatDate(event.dateEpochMs)}
                </span>
              </div>

              {event.startTimeEpochMs && (
                <div className="flex items-center">
                  <span className="font-bold w-12">TIME:</span>
                  <span className="font-mono">
                    {formatTime(event.startTimeEpochMs)}
                  </span>
                </div>
              )}
            </div>
          )}

          {/* Supporting Artists */}
          {artists.length > 1 && (
            <div className="mb-3">
              {viewMode !== "narrow" && (
                <span className="font-bold text-sm text-gray-700">WITH: </span>
              )}
              <span className="font-mono text-sm text-gray-600">
                {artists
                  .slice(1)
                  .map((artist: Artist) => artist?.name)
                  .filter(Boolean)
                  .join(", ")}
              </span>
            </div>
          )}

          {/* Price */}
          {(event.priceMin || event.priceMax || event.isFree) && (
            <div className="mt-4">
              <span
                className={`bg-red-600 text-white rounded font-bold shadow-inner inline-block ${
                  viewMode === "narrow"
                    ? "px-2 py-1 text-sm"
                    : "px-3 py-2 text-lg"
                }`}
              >
                {event.isFree
                  ? "FREE"
                  : event.priceMin === event.priceMax
                    ? `$${Math.ceil(event.priceMin || 0)}`
                    : `$${Math.ceil(event.priceMin || 0)}-$${Math.ceil(event.priceMax || 0)}`}
              </span>
            </div>
          )}
        </div>

        {/* Ticket Footer - Venue Info */}
        <div
          className="border-t-2 border-dashed px-4 py-2 text-xs text-gray-600"
          style={{
            backgroundColor: `${colors.border}20`, // 20% opacity of border color
            borderColor: colors.border,
          }}
        >
          <div className="text-center">
            <span className="font-mono font-bold">
              {venue
                ? `${venue.name.toUpperCase()} • ${getCityDisplayName(venue.city).toUpperCase()}`
                : "VENUE TBA"}
            </span>
          </div>
        </div>

        {/* SOLD OUT Stamp */}
        {(event.status === "sold-out" || event.tags.includes("sold-out")) && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none z-30">
            <img
              src="/src/assets/soldout-transparent.png"
              alt="SOLD OUT"
              className="transform rotate-12 w-64 h-auto drop-shadow-2xl"
            />
          </div>
        )}

        {/* Perforated Edge Effects */}
        <div
          className="absolute -left-2 top-0 bottom-0 w-4 bg-white opacity-60 pointer-events-none"
          style={{
            backgroundImage:
              "radial-gradient(circle, transparent 2px, white 2px)",
            backgroundSize: "8px 8px",
          }}
        ></div>
        <div
          className="absolute -right-2 top-0 bottom-0 w-4 bg-white opacity-60 pointer-events-none"
          style={{
            backgroundImage:
              "radial-gradient(circle, transparent 2px, white 2px)",
            backgroundSize: "8px 8px",
          }}
        ></div>
      </div>

      {/* Debug Information - All Event Data */}
      <div className="debug-info mt-2 text-xs bg-gray-100 dark:bg-gray-900 text-gray-900 dark:text-gray-100 font-mono p-3 rounded border-2 border-gray-300 dark:border-gray-600">
        <div className="grid grid-cols-2 gap-x-4 gap-y-1">
          {index !== undefined && (
            <div>
              <span className="text-purple-700 dark:text-purple-300 font-bold">
                Position:
              </span>{" "}
              {index + 1}
            </div>
          )}
          <div>
            <span className="text-blue-700 dark:text-blue-300 font-bold">
              ID:
            </span>{" "}
            {event.id}
          </div>
          <div>
            <span className="text-blue-700 dark:text-blue-300 font-bold">
              Slug:
            </span>{" "}
            {event.slug}
          </div>
          <div>
            <span className="text-blue-700 dark:text-blue-300 font-bold">
              Status:
            </span>{" "}
            {event.status}
          </div>
          <div>
            <span className="text-blue-700 dark:text-blue-300 font-bold">
              VenueType:
            </span>{" "}
            {event.venueType}
          </div>
          <div>
            <span className="text-blue-700 dark:text-blue-300 font-bold">
              AgeRestrict:
            </span>{" "}
            {event.ageRestriction}
          </div>
          <div>
            <span className="text-blue-700 dark:text-blue-300 font-bold">
              Timezone:
            </span>{" "}
            {event.timezone}
          </div>
          {event.description && (
            <div className="col-span-2">
              <span className="text-blue-700 dark:text-blue-300 font-bold">
                Desc:
              </span>{" "}
              {event.description}
            </div>
          )}
          {event.notes && (
            <div className="col-span-2">
              <span className="text-blue-700 dark:text-blue-300 font-bold">
                Notes:
              </span>{" "}
              {event.notes}
            </div>
          )}
          {event.ticketUrl && (
            <div className="col-span-2">
              <span className="text-blue-700 dark:text-blue-300 font-bold">
                Tix:
              </span>{" "}
              {event.ticketUrl}
            </div>
          )}
          {event.tags.length > 0 && (
            <div className="col-span-2">
              <span className="text-blue-700 dark:text-blue-300 font-bold">
                Tags:
              </span>{" "}
              {event.tags.join(", ")}
            </div>
          )}
          <div>
            <span className="text-blue-700 dark:text-blue-300 font-bold">
              SrcLine:
            </span>{" "}
            {event.sourceLineNumber}
          </div>
          <div>
            <span className="text-blue-700 dark:text-blue-300 font-bold">
              Created:
            </span>{" "}
            {new Date(event.createdAtEpochMs).toLocaleDateString()}
          </div>
        </div>
      </div>
    </div>
  );
};

export default HomePage;
