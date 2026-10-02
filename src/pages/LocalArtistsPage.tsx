/**
 * Local Artists — artists with verified Bay Area origins
 */

import React, { useEffect } from "react";
import { Link, useNavigate } from "react-router-dom";
import { DirectoryContent } from "@/components/layout/DirectoryContent.tsx";
import { isEventUpcoming } from "@/lib/discovery.ts";
import PriceWidget from "@/components/ui/PriceWidget.js";
import NewBadge from "@/components/ui/NewBadge.js";
import { useAppStore } from "@/stores/appStore.js";
import { useFilterStore } from "@/stores/filterStore.js";

const LocalArtistsPage: React.FC<{ embedded?: boolean }> = ({
  embedded = false,
}) => {
  const artists = useAppStore((s) => s.artists);
  const loading = useAppStore((s) => s.loading);
  const errors = useAppStore((s) => s.errors);
  const initialize = useAppStore((s) => s.initialize);

  const { filters, setSearchQuery } = useFilterStore();
  const navigate = useNavigate();

  const excludeSet = useAppStore((s) => s.localArtistExclude);
  const localArtistList = useAppStore((s) => s.localArtistList);

  const [artistSearch, setArtistSearch] = React.useState("");
  const [displayLimit, setDisplayLimit] = React.useState(30);
  const loadMoreRef = React.useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (artists.size === 0 && loading.artists === "idle" && !errors.artists) {
      initialize().catch(console.error);
    }
  }, [artists.size, loading.artists, errors.artists, initialize]);

  const handleArtistClick = (artistName: string) => {
    setSearchQuery(artistName);
    navigate("/shows");
  };

  const localArtists = React.useMemo(() => {
    let arr = Array.from(artists.values())
      .map((artist) => {
        if (!embedded) return artist;
        const upcomingEvents = artist.upcomingEvents.filter((event) => {
          if (!isEventUpcoming(event)) return false;
          const date = new Date(event.dateEpochMs).toISOString().slice(0, 10);
          if (
            filters.dateRange?.startDate &&
            date < filters.dateRange.startDate
          )
            return false;
          if (filters.dateRange?.endDate && date > filters.dateRange.endDate)
            return false;
          if (filters.dates?.length && !filters.dates.includes(date))
            return false;
          if (
            filters.cities?.length &&
            !filters.cities.includes(event.venueCity)
          )
            return false;
          if (
            filters.venues?.length &&
            !filters.venues.includes(event.venueName)
          )
            return false;
          return true;
        });
        return { ...artist, upcomingEvents };
      })
      .filter((a) => {
        if (excludeSet.has(a.name.toLowerCase())) return false;
        if (a.upcomingEvents.length === 0) return false;
        return localArtistList.has(a.name.toLowerCase());
      });

    if (artistSearch.trim()) {
      const q = artistSearch.trim().toLowerCase();
      arr = arr.filter((a) => a.name.toLowerCase().includes(q));
    }

    arr.sort((a, b) => {
      const va = new Set(a.upcomingEvents.map((e) => e.venueId)).size;
      const vb = new Set(b.upcomingEvents.map((e) => e.venueId)).size;
      if (vb !== va) return vb - va;
      if (b.upcomingEvents.length !== a.upcomingEvents.length)
        return b.upcomingEvents.length - a.upcomingEvents.length;
      return (
        (a.upcomingEvents[0]?.dateEpochMs ?? 0) -
        (b.upcomingEvents[0]?.dateEpochMs ?? 0)
      );
    });

    return arr;
  }, [artists, artistSearch, excludeSet, localArtistList, embedded, filters]);

  React.useEffect(() => {
    setDisplayLimit(30);
  }, [artistSearch, filters.dateRange]);

  React.useEffect(() => {
    const el = loadMoreRef.current;
    if (embedded || !el || localArtists.length <= displayLimit) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) setDisplayLimit((p) => p + 30);
      },
      { threshold: 0.1 }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [localArtists.length, displayLimit, embedded]);

  if (loading.artists === "loading") {
    return (
      <DirectoryContent embedded={embedded} title="Local Artists">
        <div className="text-center py-12">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-purple-600 mx-auto" />
        </div>
      </DirectoryContent>
    );
  }

  if (errors.artists) {
    return (
      <DirectoryContent embedded={embedded} title="Local Artists">
        <p role="alert" className="text-sm text-gray-600 dark:text-gray-400">
          Unable to load artists: {errors.artists}
        </p>
        <button
          onClick={() => initialize().catch(console.error)}
          className="mt-3 text-sm font-medium text-purple-600 dark:text-purple-400"
        >
          Try again
        </button>
      </DirectoryContent>
    );
  }

  return (
    <DirectoryContent
      embedded={embedded}
      title="Local Artists"
      subtitle={`${localArtists.length} verified Bay Area artists with upcoming shows`}
    >
      {/* Search */}
      <div className="relative mb-6">
        <svg
          className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
          />
        </svg>
        <input
          type="text"
          value={artistSearch}
          onChange={(e) => setArtistSearch(e.target.value)}
          placeholder="Search local artists..."
          aria-label="Search local artists"
          className="w-full pl-9 pr-9 py-2 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded-lg text-sm text-gray-900 dark:text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-purple-500"
        />
        {artistSearch && (
          <button
            onClick={() => setArtistSearch("")}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200"
          >
            <svg
              className="h-4 w-4"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </button>
        )}
      </div>

      {localArtists.length === 0 && (
        <div className="text-center py-12 text-gray-500 dark:text-gray-400">
          {artistSearch
            ? `No local artists matching “${artistSearch}”`
            : "No local artists playing in this date range."}
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {localArtists.slice(0, displayLimit).map((artist) => {
          const venueCount = new Set(
            artist.upcomingEvents.map((e) => e.venueId)
          ).size;
          return (
            <div
              key={artist.id}
              onClick={() => handleArtistClick(artist.name)}
              className="artist-card bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-3 hover:shadow-md transition-shadow cursor-pointer"
            >
              <div className="flex items-center gap-3 mb-2.5">
                <div className="h-10 w-10 bg-gradient-to-br from-purple-100 to-pink-100 dark:from-purple-900 dark:to-pink-900 rounded-full flex items-center justify-center shrink-0">
                  <svg
                    className="h-5 w-5 text-purple-600 dark:text-purple-400"
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
                  <h3 className="text-sm font-semibold text-gray-900 dark:text-white truncate">
                    {artist.name}
                  </h3>
                  <div className="text-xs text-gray-500 dark:text-gray-400">
                    {artist.upcomingEvents.length}{" "}
                    {artist.upcomingEvents.length === 1 ? "show" : "shows"} ·{" "}
                    {venueCount} {venueCount === 1 ? "venue" : "venues"}
                  </div>
                </div>
                <Link
                  to={`/artists/${artist.slug}`}
                  onClick={(e) => e.stopPropagation()}
                  className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 shrink-0"
                >
                  <svg
                    className="w-4 h-4"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M9 5l7 7-7 7"
                    />
                  </svg>
                </Link>
              </div>
              <div className="border-t border-gray-100 dark:border-gray-700 pt-1 space-y-0">
                {artist.upcomingEvents.map((event) => (
                  <Link
                    key={event.id}
                    to={`/events/${event.slug}`}
                    onClick={(e) => e.stopPropagation()}
                    className="flex items-center gap-1.5 py-0.5 rounded hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
                  >
                    <span className="text-xs text-gray-400 dark:text-gray-500 w-14 shrink-0 tabular-nums">
                      {new Date(event.dateEpochMs).toLocaleDateString("en-US", {
                        month: "short",
                        day: "numeric",
                      })}
                    </span>
                    <span className="text-xs text-gray-700 dark:text-gray-200 truncate flex-1 min-w-0">
                      <span className="font-medium">{event.venueName}</span>
                      {event.headlinerName &&
                        event.headlinerName !== artist.name && (
                          <span className="text-gray-400 dark:text-gray-500">
                            {" "}
                            w/ {event.headlinerName}
                          </span>
                        )}
                    </span>
                    <PriceWidget
                      isFree={event.isFree}
                      isSoldOut={event.isSoldOut}
                      priceMin={event.priceMin}
                      priceMax={event.priceMax}
                      className="text-xs shrink-0"
                    />
                    <NewBadge
                      createdAtEpochMs={event.createdAtEpochMs}
                      addedDateProvenance={event.addedDateProvenance}
                    />
                  </Link>
                ))}
              </div>
            </div>
          );
        })}

        {!embedded && localArtists.length > displayLimit && (
          <div ref={loadMoreRef} className="col-span-full text-center py-6">
            <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-gray-500 mx-auto" />
          </div>
        )}
      </div>
      {embedded && localArtists.length > displayLimit && (
        <button
          onClick={() => setDisplayLimit((limit) => limit + 30)}
          className="mt-5 text-sm font-medium text-purple-600 dark:text-purple-400"
        >
          Show more local artists
        </button>
      )}
    </DirectoryContent>
  );
};

export default LocalArtistsPage;
