/**
 * Venue detail page
 */

import React, { useEffect } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import { ContentArea } from "@/components/layout/AppShell.js";
import PriceWidget from "@/components/ui/PriceWidget.js";
import { useAppStore } from "@/stores/appStore.js";

const VenueDetailPage: React.FC = () => {
  const { slug } = useParams<{ slug: string }>();
  const navigate = useNavigate();

  const venues = useAppStore((s) => s.venues);
  const initialize = useAppStore((s) => s.initialize);
  const loading = useAppStore((s) => s.loading);

  useEffect(() => {
    if (loading.venues === "idle") initialize().catch(console.error);
  }, [loading.venues, initialize]);

  const venue = Array.from(venues.values()).find((v) => v.slug === slug);

  if (loading.venues === "loading" && !venue) {
    return (
      <ContentArea title="Loading…">
        <div className="text-center py-16">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-purple-600 mx-auto" />
        </div>
      </ContentArea>
    );
  }

  if (!venue) {
    return (
      <ContentArea title="Venue Not Found">
        <div className="text-center py-16 space-y-4">
          <p className="text-gray-500 dark:text-gray-400">This venue couldn't be found.</p>
          <button onClick={() => navigate(-1)} className="px-4 py-2 bg-purple-600 text-white rounded-lg text-sm">Go Back</button>
        </div>
      </ContentArea>
    );
  }

  return (
    <ContentArea title={venue.name} subtitle={`${venue.city}${venue.ageRestriction ? ` · ${venue.ageRestriction}` : ""}`}>
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

        {/* Venue header */}
        <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-5 space-y-3">
          <div className="flex items-start gap-4">
            <div className="h-14 w-14 bg-gradient-to-br from-blue-100 to-green-100 dark:from-blue-900 dark:to-green-900 rounded-full flex items-center justify-center shrink-0">
              <svg className="h-7 w-7 text-blue-600 dark:text-blue-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
            </div>
            <div className="flex-1 min-w-0">
              <h1 className="text-xl font-bold text-gray-900 dark:text-white">{venue.name}</h1>
              {venue.address && <div className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">{venue.address}</div>}
              <div className="text-sm text-gray-500 dark:text-gray-400">{venue.city}</div>
            </div>
          </div>

          <div className="flex flex-wrap gap-2 pt-1">
            {venue.ageRestriction && (
              <span className="text-xs bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 px-2 py-1 rounded">
                {venue.ageRestriction}
              </span>
            )}
            {venue.capacity && (
              <span className="text-xs bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 px-2 py-1 rounded">
                Cap: {venue.capacity}
              </span>
            )}
            {venue.phone && (
              <span className="text-xs bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 px-2 py-1 rounded">
                {venue.phone}
              </span>
            )}
            <span className="text-xs bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400 px-2 py-1 rounded">
              {venue.upcomingEventCount} upcoming shows
            </span>
          </div>
        </div>

        {/* Upcoming shows */}
        {venue.upcomingEvents.length > 0 && (
          <div className="space-y-2">
            <h2 className="text-xs font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-wider">Upcoming Shows</h2>
            <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 divide-y divide-gray-100 dark:divide-gray-700">
              {venue.upcomingEvents.map((event) => {
                const headliner = artists.get(event.id as unknown as never) ?? null; // handled below
                void headliner;
                const d = new Date(event.dateEpochMs);
                return (
                  <Link
                    key={event.id}
                    to={`/events/${event.slug}`}
                    className="flex items-center gap-2 px-4 py-2.5 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
                  >
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
                        {event.headlinerName || "Show"}
                      </div>
                      {event.startTimeEpochMs && (
                        <div className="text-xs text-gray-400">
                          {new Date(event.startTimeEpochMs).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}
                        </div>
                      )}
                    </div>
                    <PriceWidget isFree={event.isFree} isSoldOut={event.isSoldOut} priceMin={event.priceMin} priceMax={event.priceMax} className="text-xs shrink-0" />
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

export default VenueDetailPage;
