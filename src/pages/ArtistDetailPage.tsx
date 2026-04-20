/**
 * Artist detail page
 */

import React, { useEffect } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import { ContentArea } from "@/components/layout/AppShell.js";
import PriceWidget from "@/components/ui/PriceWidget.js";
import { useAppStore } from "@/stores/appStore.js";

const ArtistDetailPage: React.FC = () => {
  const { slug } = useParams<{ slug: string }>();
  const navigate = useNavigate();

  const artists = useAppStore((s) => s.artists);
  const venues = useAppStore((s) => s.venues);
  const initialize = useAppStore((s) => s.initialize);
  const loading = useAppStore((s) => s.loading);

  useEffect(() => {
    if (loading.artists === "idle") initialize().catch(console.error);
  }, [loading.artists, initialize]);

  const artist = Array.from(artists.values()).find((a) => a.slug === slug);

  if (loading.artists === "loading" && !artist) {
    return (
      <ContentArea title="Loading…">
        <div className="text-center py-16">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-purple-600 mx-auto" />
        </div>
      </ContentArea>
    );
  }

  if (!artist) {
    return (
      <ContentArea title="Artist Not Found">
        <div className="text-center py-16 space-y-4">
          <p className="text-gray-500 dark:text-gray-400">This artist couldn't be found.</p>
          <button onClick={() => navigate(-1)} className="px-4 py-2 bg-purple-600 text-white rounded-lg text-sm">Go Back</button>
        </div>
      </ContentArea>
    );
  }

  return (
    <ContentArea title={artist.name} subtitle={`${artist.upcomingEvents.length} upcoming show${artist.upcomingEvents.length !== 1 ? "s" : ""}`}>
      <div className="max-w-2xl space-y-4">

        <button
          onClick={() => navigate(-1)}
          className="flex items-center gap-1.5 text-sm text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white transition-colors"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 19l-7-7m0 0l7-7m-7 7h18" />
          </svg>
          Back
        </button>

        {/* Artist header */}
        <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-5">
          <div className="flex items-center gap-4">
            <div className="h-16 w-16 bg-gradient-to-br from-purple-100 to-pink-100 dark:from-purple-900 dark:to-pink-900 rounded-full flex items-center justify-center shrink-0">
              <svg className="h-8 w-8 text-purple-600 dark:text-purple-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
              </svg>
            </div>
            <div>
              <h1 className="text-xl font-bold text-gray-900 dark:text-white">{artist.name}</h1>
              {artist.aliases.length > 0 && (
                <div className="text-xs text-gray-400 mt-0.5">Also known as: {artist.aliases.join(", ")}</div>
              )}
              <div className="text-sm text-gray-500 dark:text-gray-400 mt-1">
                {artist.upcomingEvents.length} upcoming · {artist.totalEventCount} total shows
              </div>
            </div>
          </div>
        </div>

        {/* Upcoming shows */}
        {artist.upcomingEvents.length > 0 && (
          <div className="space-y-2">
            <h2 className="text-xs font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-wider">Upcoming Shows</h2>
            <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 divide-y divide-gray-100 dark:divide-gray-700">
              {artist.upcomingEvents.map((event) => {
                const venue = event.venueId ? venues.get(event.venueId) : null;
                const d = new Date(event.dateEpochMs);
                return (
                  <Link
                    key={event.id}
                    to={`/events/${event.id}`}
                    className="flex items-center gap-2 px-4 py-2.5 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
                  >
                    {/* Calendar badge */}
                    <div className="bg-gray-100 dark:bg-gray-700 rounded text-center w-9 shrink-0">
                      <div className="text-xs font-bold text-gray-400 uppercase pt-0.5">
                        {d.toLocaleDateString("en-US", { month: "short" })}
                      </div>
                      <div className="text-sm font-bold text-gray-900 dark:text-white pb-0.5">
                        {d.getDate()}
                      </div>
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-gray-900 dark:text-white truncate">
                        {venue?.name ?? event.venueName}
                      </div>
                      <div className="text-xs text-gray-400">{event.venueCity}</div>
                    </div>
                    <PriceWidget isFree={event.isFree} priceMin={event.priceMin} priceMax={event.priceMax} className="text-xs shrink-0" />
                    <svg className="w-3.5 h-3.5 text-gray-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                    </svg>
                  </Link>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </ContentArea>
  );
};

export default ArtistDetailPage;
