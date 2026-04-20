/**
 * Artists directory page
 */

import React, { useEffect } from "react";
import { Link, useNavigate, useLocation } from "react-router-dom";
import { ContentArea } from "@/components/layout/AppShell.js";
import {
  ArtistCardSkeleton,
  ListSkeleton,
} from "@/components/ui/LoadingSpinner.js";
import { useAppStore } from "@/stores/appStore.js";
import { useFilterStore } from "@/stores/filterStore.js";
import PriceWidget from "@/components/ui/PriceWidget.js";
import NewBadge from "@/components/ui/NewBadge.js";

const ArtistsPage: React.FC = () => {
  const artists = useAppStore((state) => state.artists);
  const manifest = useAppStore((state) => state.manifest);
  const loading = useAppStore((state) => state.loading);
  const errors = useAppStore((state) => state.errors);
  const initialize = useAppStore((state) => state.initialize);
  const showUpcomingOnly = useAppStore((state) => state.showUpcomingOnly);

  const { filters, setSearchQuery, clearSearch, updateFilter } =
    useFilterStore();
  const navigate = useNavigate();

  const goToVenue = (venueName: string, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    updateFilter("venues", [venueName]);
    navigate("/");
  };
  const location = useLocation();

  // Initialize display limit based on saved scroll position
  const getInitialDisplayLimit = () => {
    const scrollKey = `scroll-position-artists`;
    const savedPosition = sessionStorage.getItem(scrollKey);
    if (savedPosition) {
      const targetScroll = parseInt(savedPosition, 10);
      const estimatedItemHeight = 250;
      const estimatedItemsNeeded =
        Math.ceil(targetScroll / estimatedItemHeight) + 30;
      return Math.max(30, estimatedItemsNeeded);
    }
    return 30;
  };

  const [artistsDisplayLimit, setArtistsDisplayLimit] = React.useState(
    getInitialDisplayLimit
  );
  const [artistSearch, setArtistSearch] = React.useState("");
  const loadMoreRef = React.useRef<HTMLDivElement>(null);

  // Clear search query when returning to artists page
  React.useEffect(() => {
    clearSearch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // Only run on mount, intentionally ignoring dependencies

  // Scroll position restoration after content loads
  useEffect(() => {
    const scrollKey = `scroll-position-artists`;
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
    const scrollKey = `scroll-position-artists`;
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

  // Handle artist click - navigate to events page with search for this artist
  const handleArtistClick = (artistName: string) => {
    // Only set search query, keep other filters (cities, dates, etc.)
    setSearchQuery(artistName);
    // Navigate to home page (events list)
    navigate("/");
  };

  // Filter artists based on upcoming events flag and toolbar filters
  const allArtistsArray = React.useMemo(() => {
    let artistsArray = Array.from(artists.values());

    // Filter by upcoming events
    if (showUpcomingOnly) {
      artistsArray = artistsArray.filter((a) => a.upcomingEvents.length > 0);
    }

    // Filter by cities
    if (filters.cities && filters.cities.length > 0) {
      const selectedCities = new Set(filters.cities);
      artistsArray = artistsArray.filter((a) =>
        a.upcomingEvents.some((e) => selectedCities.has(e.venueCity))
      );
    }

    // Filter by date range
    if (filters.dateRange?.startDate || filters.dateRange?.endDate) {
      const start = filters.dateRange?.startDate ? new Date(filters.dateRange.startDate).setHours(0,0,0,0) : -Infinity;
      const end = filters.dateRange?.endDate ? new Date(filters.dateRange.endDate).setHours(23,59,59,999) : Infinity;
      artistsArray = artistsArray.filter((a) =>
        a.upcomingEvents.some((e) => e.dateEpochMs >= start && e.dateEpochMs <= end)
      );
    }

    // Filter by specific dates
    if (filters.dates && filters.dates.length > 0) {
      const selectedDates = new Set(filters.dates);
      artistsArray = artistsArray.filter((a) =>
        a.upcomingEvents.some((e) =>
          selectedDates.has(new Date(e.dateEpochMs).toISOString().split("T")[0])
        )
      );
    }

    // Filter by local search input
    if (artistSearch.trim()) {
      const q = artistSearch.trim().toLowerCase();
      artistsArray = artistsArray.filter((a) => a.name.toLowerCase().includes(q));
    }

    // Sort: most discrete venues first, then lowest price, then earliest date
    artistsArray.sort((a, b) => {
      const venueCount = (events: typeof a.upcomingEvents) => new Set(events.map((e) => e.venueId)).size;
      const va = venueCount(a.upcomingEvents);
      const vb = venueCount(b.upcomingEvents);
      if (vb !== va) return vb - va;
      const priceOf = (ev: typeof a.upcomingEvents[0] | undefined) => {
        if (!ev) return Infinity;
        if (ev.isFree) return 0;
        return ev.priceMin ?? ev.priceMax ?? Infinity;
      };
      const pa = priceOf(a.upcomingEvents[0]);
      const pb = priceOf(b.upcomingEvents[0]);
      if (pa !== pb) return pa - pb;
      return (a.upcomingEvents[0]?.dateEpochMs ?? Infinity) - (b.upcomingEvents[0]?.dateEpochMs ?? Infinity);
    });

    return artistsArray;
  }, [
    artists,
    showUpcomingOnly,
    filters.cities,
    filters.dateRange,
    filters.dates,
    artistSearch,
  ]);

  React.useEffect(() => {
    setArtistsDisplayLimit(30);
  }, [artistSearch]);

  const artistsArray = allArtistsArray.slice(0, artistsDisplayLimit);

  // Infinite scroll with Intersection Observer
  React.useEffect(() => {
    const element = loadMoreRef.current;
    if (!element || allArtistsArray.length <= artistsDisplayLimit) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) {
          setArtistsDisplayLimit((prev) => prev + 30);
        }
      },
      { threshold: 0.1 }
    );

    observer.observe(element);

    return () => {
      observer.disconnect();
    };
  }, [allArtistsArray.length, artistsDisplayLimit]);

  // Initialize app — only artists needed, no event chunks required
  useEffect(() => {
    if (artists.size === 0 && loading.artists === "idle" && !errors.artists) {
      initialize().catch(console.error);
    }
  }, [artists.size, loading.artists, errors.artists, initialize]);


  if (loading.artists === "loading") {
    return (
      <ContentArea title="Artists">
        <ListSkeleton count={12} itemSkeleton={ArtistCardSkeleton} />
      </ContentArea>
    );
  }

  if (errors.artists) {
    return (
      <ContentArea title="Artists">
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
            Unable to Load Artists
          </h3>
          <p className="text-gray-600 dark:text-gray-300">{errors.artists}</p>
        </div>
      </ContentArea>
    );
  }


  return (
    <ContentArea
      title="Artists"
      subtitle={`${allArtistsArray.length} artists in the Bay Area`}
    >
      {/* Artist search input */}
      <div className="relative mb-6">
        <svg
          className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
        </svg>
        <input
          type="text"
          value={artistSearch}
          onChange={(e) => setArtistSearch(e.target.value)}
          placeholder="Search artists..."
          className="w-full pl-9 pr-9 py-2 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded-lg text-sm text-gray-900 dark:text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-purple-500 focus:border-transparent"
        />
        {artistSearch && (
          <button
            onClick={() => setArtistSearch("")}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200"
          >
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        )}
      </div>

      <>
        {allArtistsArray.length === 0 && artistSearch ? (
          <div className="text-center py-12 text-gray-500 dark:text-gray-400">
            No artists found matching &ldquo;{artistSearch}&rdquo;
          </div>
        ) : null}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {artistsArray.map((artist) => {
            const artistEvents = artist.upcomingEvents;

            return (
              <div
                key={artist.id}
                onClick={() => handleArtistClick(artist.name)}
                className={`artist-card ${artistEvents.length === 0 ? "no-upcoming" : ""} bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-3 hover:shadow-md transition-shadow cursor-pointer`}
              >
                <div className="space-y-2.5">
                  {/* Header with Avatar and Title */}
                  <div className="flex items-center space-x-4">
                    <div className="h-12 w-12 bg-gradient-to-br from-purple-100 to-pink-100 dark:from-purple-900 dark:to-pink-900 rounded-full flex items-center justify-center">
                      <svg
                        className="h-6 w-6 text-purple-600 dark:text-purple-400"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"
                        />
                      </svg>
                    </div>
                    <div className="flex-1 min-w-0">
                      <h3 className="text-lg font-semibold text-gray-900 dark:text-white truncate">
                        {artist.name}
                      </h3>
                      <div className="text-sm text-gray-600 dark:text-gray-300">
                        {artistEvents.length > 0
                          ? `${artistEvents.length} upcoming show${artistEvents.length !== 1 ? "s" : ""}`
                          : "No upcoming shows"}
                      </div>
                    </div>
                  </div>

                  {/* All events — compact rows */}
                  {artistEvents.length > 0 && (
                    <div className="border-t border-gray-100 dark:border-gray-700 pt-1 space-y-0">
                      {artistEvents.map((event) => (
                        <Link
                          key={event.id}
                          to={`/events/${event.id}`}
                          onClick={(e) => e.stopPropagation()}
                          className="flex items-center gap-1.5 py-0.5 rounded hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
                        >
                          <span className="text-xs text-gray-400 dark:text-gray-500 w-14 shrink-0 tabular-nums">
                            {new Date(event.dateEpochMs).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                          </span>
                          <button
                            onClick={(e) => goToVenue(event.venueName, e)}
                            className="text-xs text-gray-700 dark:text-gray-200 truncate font-medium flex-1 text-left hover:underline"
                          >
                            {event.venueName}
                          </button>
                          <PriceWidget
                            isFree={event.isFree}
                            priceMin={event.priceMin}
                            priceMax={event.priceMax}
                            className="text-xs shrink-0"
                          />
                          {manifest?.latestIngestionDate && (
                            <NewBadge createdAtEpochMs={event.createdAtEpochMs} latestIngestionDate={manifest.latestIngestionDate} />
                          )}
                        </Link>
                      ))}
                    </div>
                  )}

                  {/* Aliases */}
                  {artist.aliases && artist.aliases.length > 0 && (
                    <div className="text-xs text-gray-500 dark:text-gray-400">
                      Also known as: {artist.aliases.join(", ")}
                    </div>
                  )}

                  {/* Debug ID Information */}
                  <div className="debug-info mt-2 space-y-1">
                    <div className="debug-label">Artist Debug Info:</div>
                    <div>
                      Artist:{" "}
                      <span className="debug-id artist-id">{artist.id}</span>
                    </div>
                    {artistEvents[0] && (
                      <div className="space-y-1">
                        <div>
                          Next Event:{" "}
                          <span className="debug-id event-id">
                            {artistEvents[0].id}
                          </span>
                        </div>
                        {artistEvents[0].venueId && (
                          <div>
                            Venue:{" "}
                            <span className="debug-id venue-id">
                              {artistEvents[0].venueId}
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
          {allArtistsArray.length > artistsDisplayLimit && (
            <div ref={loadMoreRef} className="col-span-full text-center py-6">
              <div className="inline-flex items-center space-x-2 text-gray-500 dark:text-gray-400">
                <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-gray-500"></div>
                <span className="text-sm">Loading more artists...</span>
              </div>
            </div>
          )}
        </div>
      </>
    </ContentArea>
  );
};

export default ArtistsPage;
