/**
 * Local Artists — artists playing 3+ shows at 2+ distinct venues
 */

import React, { useEffect } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ContentArea } from "@/components/layout/AppShell.js";
import PriceWidget from "@/components/ui/PriceWidget.js";
import NewBadge from "@/components/ui/NewBadge.js";
import { useAppStore } from "@/stores/appStore.js";
import { useFilterStore } from "@/stores/filterStore.js";

const MIN_EVENTS = 3;
const MIN_VENUES = 2;

const LocalArtistsPage: React.FC = () => {
  const artists = useAppStore((s) => s.artists);
  const manifest = useAppStore((s) => s.manifest);
  const loading = useAppStore((s) => s.loading);
  const errors = useAppStore((s) => s.errors);
  const initialize = useAppStore((s) => s.initialize);

  const { setSearchQuery, updateFilter } = useFilterStore();
  const navigate = useNavigate();

  const goToVenue = (venueName: string, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    updateFilter("venues", [venueName]);
    navigate("/");
  };

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
    navigate("/");
  };

  const localArtists = React.useMemo(() => {
    let arr = Array.from(artists.values()).filter((a) => {
      const venueCount = new Set(a.upcomingEvents.map((e) => e.venueId)).size;
      return a.upcomingEvents.length >= MIN_EVENTS && venueCount >= MIN_VENUES;
    });

    if (artistSearch.trim()) {
      const q = artistSearch.trim().toLowerCase();
      arr = arr.filter((a) => a.name.toLowerCase().includes(q));
    }

    arr.sort((a, b) => {
      const va = new Set(a.upcomingEvents.map((e) => e.venueId)).size;
      const vb = new Set(b.upcomingEvents.map((e) => e.venueId)).size;
      if (vb !== va) return vb - va;
      if (b.upcomingEvents.length !== a.upcomingEvents.length) return b.upcomingEvents.length - a.upcomingEvents.length;
      return (a.upcomingEvents[0]?.dateEpochMs ?? 0) - (b.upcomingEvents[0]?.dateEpochMs ?? 0);
    });

    return arr;
  }, [artists, artistSearch]);

  React.useEffect(() => { setDisplayLimit(30); }, [artistSearch]);

  React.useEffect(() => {
    const el = loadMoreRef.current;
    if (!el || localArtists.length <= displayLimit) return;
    const observer = new IntersectionObserver(
      (entries) => { if (entries[0].isIntersecting) setDisplayLimit((p) => p + 30); },
      { threshold: 0.1 }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [localArtists.length, displayLimit]);

  if (loading.artists === "loading") {
    return <ContentArea title="Local Artists"><div className="text-center py-12"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-purple-600 mx-auto" /></div></ContentArea>;
  }

  return (
    <ContentArea title="Local Artists" subtitle={`${localArtists.length} artists playing 3+ shows across multiple venues`}>
      {/* Search */}
      <div className="relative mb-6">
        <svg className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
        </svg>
        <input
          type="text"
          value={artistSearch}
          onChange={(e) => setArtistSearch(e.target.value)}
          placeholder="Search local artists..."
          className="w-full pl-9 pr-9 py-2 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded-lg text-sm text-gray-900 dark:text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-purple-500"
        />
        {artistSearch && (
          <button onClick={() => setArtistSearch("")} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200">
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        )}
      </div>

      {localArtists.length === 0 && artistSearch && (
        <div className="text-center py-12 text-gray-500 dark:text-gray-400">No local artists matching &ldquo;{artistSearch}&rdquo;</div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {localArtists.slice(0, displayLimit).map((artist) => {
          const venueCount = new Set(artist.upcomingEvents.map((e) => e.venueId)).size;
          return (
            <div
              key={artist.id}
              onClick={() => handleArtistClick(artist.name)}
              className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-3 hover:shadow-md transition-shadow cursor-pointer"
            >
              <div className="flex items-center gap-3 mb-2.5">
                <div className="h-10 w-10 bg-gradient-to-br from-purple-100 to-pink-100 dark:from-purple-900 dark:to-pink-900 rounded-full flex items-center justify-center shrink-0">
                  <svg className="h-5 w-5 text-purple-600 dark:text-purple-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
                  </svg>
                </div>
                <div className="flex-1 min-w-0">
                  <h3 className="text-sm font-semibold text-gray-900 dark:text-white truncate">{artist.name}</h3>
                  <div className="text-xs text-gray-500 dark:text-gray-400">
                    {artist.upcomingEvents.length} shows · {venueCount} venues
                  </div>
                </div>
                <Link
                  to={`/artists/${artist.slug}`}
                  onClick={(e) => e.stopPropagation()}
                  className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 shrink-0"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
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
                      {new Date(event.dateEpochMs).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                    </span>
                    <span className="text-xs text-gray-700 dark:text-gray-200 truncate font-medium flex-1">
                      {event.venueName}
                    </span>
                    <PriceWidget isFree={event.isFree} isSoldOut={event.isSoldOut} priceMin={event.priceMin} priceMax={event.priceMax} className="text-xs shrink-0" />
                    {manifest?.latestIngestionDate && (
                      <NewBadge createdAtEpochMs={event.createdAtEpochMs} latestIngestionDate={manifest.latestIngestionDate} />
                    )}
                  </Link>
                ))}
              </div>
            </div>
          );
        })}

        {localArtists.length > displayLimit && (
          <div ref={loadMoreRef} className="col-span-full text-center py-6">
            <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-gray-500 mx-auto" />
          </div>
        )}
      </div>
    </ContentArea>
  );
};

export default LocalArtistsPage;
