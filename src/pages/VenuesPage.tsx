/**
 * Venues directory page
 */

import React, { useEffect } from "react";
import { Link, useNavigate, useLocation } from "react-router-dom";
import { ContentArea } from "@/components/layout/AppShell.js";
import {
  VenueCardSkeleton,
  ListSkeleton,
} from "@/components/ui/LoadingSpinner.js";
import { useAppStore } from "@/stores/appStore.js";
import { useFilterStore } from "@/stores/filterStore.js";

const VenuesPage: React.FC = () => {
  const venues = useAppStore((state) => state.venues);
  const loading = useAppStore((state) => state.loading);
  const errors = useAppStore((state) => state.errors);
  const getUpcomingEvents = useAppStore((state) => state.getUpcomingEvents);
  const getArtist = useAppStore((state) => state.getArtist);
  const showUpcomingOnly = useAppStore((state) => state.showUpcomingOnly);

  const { filters, updateFilter, clearFilter } = useFilterStore();
  const navigate = useNavigate();
  const location = useLocation();

  // Initialize display limit based on saved scroll position
  const getInitialDisplayLimit = () => {
    const scrollKey = `scroll-position-venues`;
    const savedPosition = sessionStorage.getItem(scrollKey);
    if (savedPosition) {
      const targetScroll = parseInt(savedPosition, 10);
      const estimatedItemHeight = 300;
      const estimatedItemsNeeded =
        Math.ceil(targetScroll / estimatedItemHeight) + 30;
      return Math.max(30, estimatedItemsNeeded);
    }
    return 30;
  };

  const [venuesDisplayLimit, setVenuesDisplayLimit] = React.useState(
    getInitialDisplayLimit
  );
  const loadMoreRef = React.useRef<HTMLDivElement>(null);

  // Clear venue filter when returning to venues page
  React.useEffect(() => {
    if (filters.venues && filters.venues.length > 0) {
      clearFilter("venues");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // Only run on mount, intentionally ignoring dependencies

  // Scroll position restoration after content loads
  useEffect(() => {
    const scrollKey = `scroll-position-venues`;
    const mainElement = document.querySelector("main");

    if (!mainElement) return;

    const savedPosition = sessionStorage.getItem(scrollKey);
    if (savedPosition) {
      const targetScroll = parseInt(savedPosition, 10);

      // Restore scroll position after content loads
      const timeoutId = setTimeout(() => {
        mainElement.scrollTop = targetScroll;
      }, 300);

      return () => clearTimeout(timeoutId);
    }
  }, [location.pathname]);

  // Save scroll position continuously as user scrolls
  useEffect(() => {
    const scrollKey = `scroll-position-venues`;
    const mainElement = document.querySelector("main");

    if (!mainElement) return;

    let scrollTimeout: NodeJS.Timeout;
    const handleScroll = () => {
      clearTimeout(scrollTimeout);
      scrollTimeout = setTimeout(() => {
        sessionStorage.setItem(scrollKey, mainElement.scrollTop.toString());
      }, 100);
    };

    mainElement.addEventListener("scroll", handleScroll);

    return () => {
      mainElement.removeEventListener("scroll", handleScroll);
      clearTimeout(scrollTimeout);
    };
  }, []);

  // Handle venue click - navigate to events page filtered by this venue
  const handleVenueClick = (venueName: string) => {
    // Only clear venue filter and search, keep other filters (cities, dates, etc.)
    updateFilter("venues", [venueName]);
    // Navigate to home page (events list)
    navigate("/");
  };

  // Filter venues based on upcoming events flag and toolbar filters
  const allVenuesArray = React.useMemo(() => {
    let venuesArray = Array.from(venues.values());

    // Filter by upcoming events
    if (showUpcomingOnly) {
      venuesArray = venuesArray.filter((venue) => venue.upcomingEventCount > 0);
    }

    // Filter by cities - show venues in selected cities
    if (filters.cities && filters.cities.length > 0) {
      venuesArray = venuesArray.filter((venue) => {
        return filters.cities.includes(venue.city);
      });
    }

    // Filter by age restrictions - show venues matching selected age restrictions
    if (filters.ageRestrictions && filters.ageRestrictions.length > 0) {
      venuesArray = venuesArray.filter((venue) => {
        return filters.ageRestrictions.some((restriction) => {
          const venueAge = venue.ageRestriction?.toLowerCase() || "";
          const filterAge = restriction.toLowerCase();

          // Handle "all-ages" variations
          if (filterAge === "all-ages" || filterAge === "all ages") {
            return (
              venueAge.includes("all") ||
              venueAge.includes("a/a") ||
              venueAge === "all-ages"
            );
          }

          // Handle specific age restrictions (18+, 21+, etc.)
          return venueAge.includes(filterAge);
        });
      });
    }

    // Filter by date range - show venues with events in the date range
    if (filters.dateRange?.startDate || filters.dateRange?.endDate) {
      venuesArray = venuesArray.filter((venue) => {
        const allUpcomingEvents = getUpcomingEvents(Infinity);
        const venueEvents = allUpcomingEvents.filter(
          (event) => event.venueId === venue.id
        );

        // Check if any event is in the date range
        return venueEvents.some((event) => {
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
      });
    }

    // Filter by specific dates
    if (filters.dates && filters.dates.length > 0) {
      venuesArray = venuesArray.filter((venue) => {
        const allUpcomingEvents = getUpcomingEvents(Infinity);
        const venueEvents = allUpcomingEvents.filter(
          (event) => event.venueId === venue.id
        );

        // Check if any event is on a selected date
        return venueEvents.some((event) => {
          const eventDate = new Date(event.dateEpochMs)
            .toISOString()
            .split("T")[0];
          return filters.dates.includes(eventDate);
        });
      });
    }

    return venuesArray;
  }, [
    venues,
    showUpcomingOnly,
    filters.cities,
    filters.ageRestrictions,
    filters.dateRange,
    filters.dates,
    getUpcomingEvents,
  ]);

  const venuesArray = allVenuesArray.slice(0, venuesDisplayLimit);

  // Infinite scroll with Intersection Observer
  React.useEffect(() => {
    const element = loadMoreRef.current;
    if (!element || allVenuesArray.length <= venuesDisplayLimit) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) {
          setVenuesDisplayLimit((prev) => prev + 30);
        }
      },
      { threshold: 0.1 }
    );

    observer.observe(element);

    return () => {
      observer.disconnect();
    };
  }, [allVenuesArray.length, venuesDisplayLimit]);

  // Helper function to get next event for a venue
  const getNextEventForVenue = (venueId: number) => {
    const allUpcomingEvents = getUpcomingEvents(100); // Get more events to search through
    return allUpcomingEvents.find((event) => event.venueId === venueId);
  };

  // No longer grouping by city for better grid layout

  if (loading.venues === "loading") {
    return (
      <ContentArea title="Venues">
        <ListSkeleton count={10} itemSkeleton={VenueCardSkeleton} />
      </ContentArea>
    );
  }

  if (errors.venues) {
    return (
      <ContentArea title="Venues">
        <div className="text-center py-12">
          <div className="text-red-600 mb-4">
            <svg
              className="h-12 w-12 mx-auto"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
              />
            </svg>
          </div>
          <h3 className="text-lg font-medium text-gray-900 dark:text-white mb-2">
            Unable to Load Venues
          </h3>
          <p className="text-gray-600 dark:text-gray-300">{errors.venues}</p>
        </div>
      </ContentArea>
    );
  }

  return (
    <ContentArea
      title="Venues"
      subtitle={`${venuesArray.length} venues across the Bay Area`}
    >
      {/* Debug info */}
      <div className="debug-info mb-4 space-y-1">
        <div className="debug-label">Page Debug Info:</div>
        <div>Venues loaded: {venuesArray.length}</div>
        <div>Events loaded: {getUpcomingEvents(100).length}</div>
        <div>
          Loading states: venues={loading.venues}, events={loading.events}
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {venuesArray.map((venue) => {
          const nextEvent = getNextEventForVenue(venue.id);
          const headlinerArtist = nextEvent?.headlinerArtistId
            ? getArtist(nextEvent.headlinerArtistId)
            : null;

          return (
            <div
              key={venue.id}
              onClick={() => handleVenueClick(venue.name)}
              className={`venue-card ${venue.upcomingEventCount === 0 ? "no-upcoming" : ""} bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden hover:shadow-md transition-shadow cursor-pointer`}
            >
              {/* Google Maps Placeholder */}
              <div className="h-32 bg-gradient-to-br from-green-100 to-blue-100 dark:from-green-900 dark:to-blue-900 relative flex items-center justify-center">
                <div className="absolute inset-0 bg-gray-200 dark:bg-gray-700 opacity-30"></div>
                <div className="relative z-10 text-center">
                  <svg
                    className="w-8 h-8 mx-auto text-gray-500 dark:text-gray-400 mb-2"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z"
                    />
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M15 11a3 3 0 11-6 0 3 3 0 016 0z"
                    />
                  </svg>
                  <div className="text-xs text-gray-600 dark:text-gray-400 font-medium">
                    Map View
                  </div>
                </div>
              </div>

              <div className="p-6">
                <div className="mb-4">
                  <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-1">
                    {venue.name}
                  </h3>
                  <div className="text-sm text-gray-600 dark:text-gray-300 mb-2">
                    {venue.address}
                  </div>
                  <div className="text-sm text-gray-600 dark:text-gray-300">
                    {venue.city}
                  </div>
                </div>

                <div className="flex items-center justify-between mb-4">
                  <div className="flex items-center space-x-2">
                    <span className="inline-block bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 text-xs px-2 py-1 rounded-full">
                      {venue.ageRestriction}
                    </span>
                    {venue.capacity && (
                      <span className="text-xs text-gray-500 dark:text-gray-400">
                        Cap: {venue.capacity}
                      </span>
                    )}
                  </div>

                  <div className="text-sm text-gray-600 dark:text-gray-300">
                    {venue.upcomingEventCount > 0
                      ? `${venue.upcomingEventCount} upcoming`
                      : "No upcoming shows"}
                  </div>
                </div>

                {/* Next Show */}
                {nextEvent && (
                  <Link
                    to={`/events/${nextEvent.id}`}
                    onClick={(e) => e.stopPropagation()}
                    className="block mb-4 bg-gray-50 dark:bg-gray-700 rounded-lg p-4 hover:bg-gray-100 dark:hover:bg-gray-600 transition-colors"
                  >
                    <div className="flex items-start space-x-3">
                      {/* Tear-off Calendar Date */}
                      <div className="flex-shrink-0">
                        <div className="bg-white dark:bg-gray-800 rounded shadow-sm border border-gray-200 dark:border-gray-600 overflow-hidden w-8">
                          {/* Calendar Header */}
                          <div className="bg-blue-500 text-white text-center py-0.5">
                            <div className="text-xs font-bold uppercase leading-tight">
                              {new Date(nextEvent.dateEpochMs)
                                .toLocaleDateString("en-US", {
                                  month: "short",
                                })
                                .toUpperCase()}
                            </div>
                          </div>
                          {/* Date */}
                          <div className="text-center py-1">
                            <div className="text-sm font-bold text-gray-900 dark:text-white leading-none">
                              {new Date(nextEvent.dateEpochMs).getDate()}
                            </div>
                          </div>
                        </div>
                      </div>

                      {/* Event Details */}
                      <div className="flex-1 min-w-0 space-y-1">
                        <div className="text-sm">
                          <span className="font-semibold text-green-600 dark:text-green-400">
                            {nextEvent.isFree
                              ? "FREE"
                              : nextEvent.priceMin === nextEvent.priceMax
                                ? `$${Math.ceil(nextEvent.priceMin || 0)}`
                                : `$${Math.ceil(nextEvent.priceMin || 0)}-${Math.ceil(nextEvent.priceMax || 0)}`}
                          </span>
                          <span className="font-medium text-gray-900 dark:text-gray-100 ml-2">
                            {nextEvent.startTimeEpochMs
                              ? new Date(
                                  nextEvent.startTimeEpochMs
                                ).toLocaleTimeString("en-US", {
                                  hour: "numeric",
                                  minute: "2-digit",
                                })
                              : "TBA"}
                          </span>
                        </div>
                        <div className="text-sm text-gray-600 dark:text-gray-400">
                          {headlinerArtist?.name || "Show"} •{" "}
                          {nextEvent.tags?.[0] || "Live Music"}
                        </div>
                      </div>
                    </div>
                  </Link>
                )}

                {venue.phone && (
                  <div className="text-xs text-gray-500 dark:text-gray-400">
                    {venue.phone}
                  </div>
                )}

                {/* Debug ID Information */}
                <div className="debug-info mt-2 space-y-1">
                  <div className="debug-label">Venue Debug Info:</div>
                  <div>
                    Venue: <span className="debug-id venue-id">{venue.id}</span>
                  </div>
                  {nextEvent && (
                    <div className="space-y-1">
                      <div>
                        Next Event:{" "}
                        <span className="debug-id event-id">
                          {nextEvent.id}
                        </span>
                      </div>
                      {nextEvent.headlinerArtistId && (
                        <div>
                          Headliner:{" "}
                          <span className="debug-id artist-id">
                            {nextEvent.headlinerArtistId}
                          </span>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </div>
          );
        })}

        {/* Infinite scroll trigger */}
        {allVenuesArray.length > venuesDisplayLimit && (
          <div ref={loadMoreRef} className="col-span-full text-center py-6">
            <div className="inline-flex items-center space-x-2 text-gray-500 dark:text-gray-400">
              <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-gray-500"></div>
              <span className="text-sm">Loading more venues...</span>
            </div>
          </div>
        )}
      </div>
    </ContentArea>
  );
};

export default VenuesPage;
