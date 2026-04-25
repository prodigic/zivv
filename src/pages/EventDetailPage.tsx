/**
 * Event detail page
 */

import React, { useEffect } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import { ContentArea } from "@/components/layout/AppShell.js";
import PriceWidget from "@/components/ui/PriceWidget.js";
import { useAppStore } from "@/stores/appStore.js";

const EventDetailPage: React.FC = () => {
  const { slug } = useParams<{ slug: string }>();
  const navigate = useNavigate();

  const events = useAppStore((s) => s.events);
  const artists = useAppStore((s) => s.artists);
  const venues = useAppStore((s) => s.venues);
  const manifest = useAppStore((s) => s.manifest);
  const initialize = useAppStore((s) => s.initialize);
  const loadChunk = useAppStore((s) => s.loadChunk);
  const loadedChunks = useAppStore((s) => s.loadedChunks);
  const loading = useAppStore((s) => s.loading);

  // Initialize if needed
  useEffect(() => {
    if (loading.artists === "idle") initialize().catch(console.error);
  }, [loading.artists, initialize]);

  // Find event by slug
  const event = slug ? Array.from(events.values()).find((e) => e.slug === slug) : undefined;

  // Load the right chunk if event not found yet
  useEffect(() => {
    if (event || !slug || !manifest?.chunks?.events) return;
    // Slug starts with YYYY-MM, use that to find the right chunk first
    const chunkId = slug.slice(0, 7); // "YYYY-MM"
    const loadAll = async () => {
      // Try the matching month chunk first
      const prioritized = [
        ...manifest.chunks.events.filter((c) => c.chunkId === chunkId),
        ...manifest.chunks.events.filter((c) => c.chunkId !== chunkId),
      ];
      for (const chunk of prioritized) {
        if (!loadedChunks.has(chunk.chunkId)) {
          await loadChunk(chunk.chunkId);
          const found = Array.from(useAppStore.getState().events.values()).find((e) => e.slug === slug);
          if (found) break;
        }
      }
    };
    loadAll().catch(console.error);
  }, [event, slug, manifest, loadedChunks, loadChunk]);

  const isLoading = loading.events === "loading" || loading.artists === "loading";

  if (!event && isLoading) {
    return (
      <ContentArea title="Loading…">
        <div className="text-center py-16">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-purple-600 mx-auto" />
        </div>
      </ContentArea>
    );
  }

  if (!event) {
    return (
      <ContentArea title="Event Not Found">
        <div className="text-center py-16 space-y-4">
          <p className="text-gray-500 dark:text-gray-400">This event couldn't be found.</p>
          <button onClick={() => navigate(-1)} className="px-4 py-2 bg-purple-600 text-white rounded-lg text-sm">Go Back</button>
        </div>
      </ContentArea>
    );
  }

  const headliner = event.headlinerArtistId ? artists.get(event.headlinerArtistId) : null;
  const venue = event.venueId ? venues.get(event.venueId) : null;
  const supportingArtists = event.artistIds
    .filter((id) => id !== event.headlinerArtistId)
    .map((id) => artists.get(id))
    .filter(Boolean);

  const d = new Date(event.dateEpochMs);
  const dateStr = d.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });
  const timeStr = event.startTimeEpochMs
    ? new Date(event.startTimeEpochMs).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })
    : null;

  const statusColors: Record<string, string> = {
    "confirmed": "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300",
    "sold-out": "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300",
    "cancelled": "bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-400",
    "postponed": "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/40 dark:text-yellow-300",
  };

  const allArtists = [headliner, ...supportingArtists].filter(Boolean);
  const venueMonthEvents = venue ? venue.upcomingEvents : [];

  const currentIndex = venueMonthEvents.findIndex((ev) => ev.id === event.id);
  const prevEvent = currentIndex > 0 ? venueMonthEvents[currentIndex - 1] : null;
  const nextEvent = currentIndex >= 0 && currentIndex < venueMonthEvents.length - 1 ? venueMonthEvents[currentIndex + 1] : null;

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === "ArrowUp" && prevEvent) navigate(`/events/${prevEvent.slug}`);
      if (e.key === "ArrowDown" && nextEvent) navigate(`/events/${nextEvent.slug}`);
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [prevEvent, nextEvent, navigate]);

  return (
    <ContentArea title="" subtitle="">
      {/* Up/down nav between venue events */}
      {(prevEvent || nextEvent) && (
        <div className="flex items-center gap-1 mb-3 text-xs text-gray-400 dark:text-gray-500">
          <button
            disabled={!prevEvent}
            onClick={() => prevEvent && navigate(`/events/${prevEvent.slug}`)}
            title="Previous show at this venue (↑)"
            className="flex items-center gap-1 px-2 py-0.5 rounded hover:bg-gray-100 dark:hover:bg-gray-700 disabled:opacity-30 disabled:cursor-default transition-colors"
          >
            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" /></svg>
            {prevEvent && <span className="truncate max-w-[160px]">{prevEvent.headlinerName}</span>}
          </button>
          <span className="text-gray-200 dark:text-gray-700">/</span>
          <button
            disabled={!nextEvent}
            onClick={() => nextEvent && navigate(`/events/${nextEvent.slug}`)}
            title="Next show at this venue (↓)"
            className="flex items-center gap-1 px-2 py-0.5 rounded hover:bg-gray-100 dark:hover:bg-gray-700 disabled:opacity-30 disabled:cursor-default transition-colors"
          >
            {nextEvent && <span className="truncate max-w-[160px]">{nextEvent.headlinerName}</span>}
            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>
          </button>
        </div>
      )}

      {/* Single-row header: back · artist · venue */}
      <div className="flex items-baseline gap-3 mb-5">
        <button
          onClick={() => navigate(-1)}
          className="flex items-center gap-1 text-sm text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white transition-colors shrink-0"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 19l-7-7m0 0l7-7m-7 7h18" />
          </svg>
          Back
        </button>
        <span className="text-gray-300 dark:text-gray-600">·</span>
        <h1 className="text-xl font-bold text-gray-900 dark:text-white truncate">{headliner?.name ?? "Show"}</h1>
        {venue && (
          <>
            <span className="text-gray-300 dark:text-gray-600 shrink-0">·</span>
            <Link to={`/venues/${venue.slug}`} className="text-xl font-bold text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white truncate">
              {venue.name}
            </Link>
          </>
        )}
        {event.status && event.status !== "confirmed" && (
          <span className={`text-xs font-semibold px-2 py-1 rounded shrink-0 ml-auto ${statusColors[event.status] ?? ""}`}>
            {event.status.replace("-", " ").toUpperCase()}
          </span>
        )}
      </div>

      {/* Outer 3-col grid: venue (1/3) left, event+artists (2/3) right */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 items-start">
        {/* Event summary + artist cards — col-span-2, visually on the right */}
        <div className="md:col-span-2 md:order-last space-y-4 md:sticky md:top-4 md:self-start">

        {/* Event summary card */}
        <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-4 space-y-3">
          {/* Supporting artists */}
          {supportingArtists.length > 0 && (
            <div className="text-sm text-gray-500 dark:text-gray-400">
              with {supportingArtists.map((a, i) => (
                <React.Fragment key={a!.id}>
                  {i > 0 && ", "}
                  <Link to={`/artists/${a!.slug}`} className="hover:underline">{a!.name}</Link>
                </React.Fragment>
              ))}
            </div>
          )}

          {/* Date / time / venue */}
          <div className="space-y-1.5">
            <div className="flex items-center gap-2 text-sm">
              <svg className="w-4 h-4 text-gray-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
              </svg>
              <span className="text-gray-900 dark:text-white">{dateStr}</span>
              {timeStr && <span className="text-gray-500 dark:text-gray-400">· {timeStr}</span>}
            </div>
            {venue && (
              <div className="flex items-start gap-2 text-sm">
                <svg className="w-4 h-4 text-gray-400 shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" />
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" />
                </svg>
                <div>
                  <Link to={`/venues/${venue.slug}`} className="font-medium text-gray-900 dark:text-white hover:underline">{venue.name}</Link>
                  <div className="text-gray-500 dark:text-gray-400 text-xs">{venue.address}{venue.city ? `, ${venue.city}` : ""}</div>
                </div>
              </div>
            )}
          </div>

          {/* Price / age / tags */}
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <PriceWidget isFree={event.isFree} isSoldOut={event.status === "sold-out" || event.tags?.includes("sold-out")} priceMin={event.priceMin} priceMax={event.priceMax} className="text-sm" />
            {event.ageRestriction && (
              <span className="text-xs bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 px-2 py-1 rounded">{event.ageRestriction}</span>
            )}
            {event.tags?.map((tag) => (
              <span key={tag} className="text-xs bg-purple-100 dark:bg-purple-900/40 text-purple-700 dark:text-purple-300 px-2 py-1 rounded">{tag}</span>
            ))}
            {event.ticketUrl && (
              <a href={event.ticketUrl} target="_blank" rel="noopener noreferrer"
                className="ml-auto inline-flex items-center gap-1 px-3 py-1.5 bg-purple-600 hover:bg-purple-700 text-white text-xs rounded-lg transition-colors">
                Tickets
                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                </svg>
              </a>
            )}
          </div>

          {(event.description || event.notes) && (
            <div className="text-sm text-gray-600 dark:text-gray-300 space-y-1 pt-1 border-t border-gray-100 dark:border-gray-700">
              {event.description && <p>{event.description}</p>}
              {event.notes && <p className="text-gray-400 dark:text-gray-500 italic">{event.notes}</p>}
            </div>
          )}
        </div>{/* end event summary card */}

        {/* Artist cards — 2-col inside left column */}
        {allArtists.length > 0 && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {allArtists.map((artist) => (
              <Link
                key={artist!.id}
                to={`/artists/${artist!.slug}`}
                className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-3 hover:shadow-md transition-shadow"
              >
                <div className="flex items-center gap-3 mb-2.5">
                  <div className="h-10 w-10 bg-gradient-to-br from-purple-100 to-pink-100 dark:from-purple-900 dark:to-pink-900 rounded-full flex items-center justify-center shrink-0">
                    <svg className="h-5 w-5 text-purple-600 dark:text-purple-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
                    </svg>
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-semibold text-gray-900 dark:text-white truncate">{artist!.name}</div>
                    <div className="text-xs text-gray-500 dark:text-gray-400">{artist!.upcomingEvents.length} upcoming show{artist!.upcomingEvents.length !== 1 ? "s" : ""}</div>
                  </div>
                </div>
                {artist!.upcomingEvents.length > 0 && (
                  <div className="border-t border-gray-100 dark:border-gray-700 pt-1 space-y-0">
                    {artist!.upcomingEvents.slice(0, 4).map((ev) => (
                      <div key={ev.id} className="flex items-center gap-1.5 py-0.5">
                        <span className="text-xs text-gray-400 dark:text-gray-500 w-14 shrink-0 tabular-nums">
                          {new Date(ev.dateEpochMs).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                        </span>
                        <span className="text-xs text-gray-700 dark:text-gray-200 truncate font-medium flex-1">{ev.venueName}</span>
                        <PriceWidget isFree={ev.isFree} isSoldOut={ev.status === "sold-out" || ev.tags?.includes("sold-out")} priceMin={ev.priceMin} priceMax={ev.priceMax} className="text-xs shrink-0" />
                      </div>
                    ))}
                  </div>
                )}
              </Link>
            ))}
          </div>
        )}

        </div>{/* end col-span-2 */}

        {/* Venue card — col 1, visually on the left via order */}
        {venue && (
          <div className="md:order-first bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-3">
            <Link to={`/venues/${venue.slug}`} className="flex items-center gap-3 mb-2.5 group">
              <div className="h-10 w-10 bg-gradient-to-br from-blue-100 to-green-100 dark:from-blue-900 dark:to-green-900 rounded-full flex items-center justify-center shrink-0">
                <svg className="h-5 w-5 text-blue-600 dark:text-blue-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" />
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" />
                </svg>
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-semibold text-gray-900 dark:text-white truncate group-hover:underline">{venue.name}</div>
                <div className="text-xs text-gray-500 dark:text-gray-400">{venue.city}{venue.ageRestriction ? ` · ${venue.ageRestriction}` : ""} · {venue.upcomingEvents.length} shows</div>
              </div>
            </Link>
            {venueMonthEvents.length > 0 && (
              <div className="border-t border-gray-100 dark:border-gray-700 pt-1 space-y-0">
                {venueMonthEvents.map((ev) => {
                  const isCurrent = ev.id === event.id;
                  return (
                    <Link
                      key={ev.id}
                      to={`/events/${ev.slug}`}
                      className={`flex items-center gap-1.5 py-0.5 rounded transition-colors ${
                        isCurrent
                          ? "bg-purple-100 dark:bg-purple-900/40 font-semibold"
                          : "hover:bg-gray-50 dark:hover:bg-gray-700"
                      }`}
                    >
                      <span className={`text-xs w-14 shrink-0 tabular-nums ${isCurrent ? "text-purple-600 dark:text-purple-400" : "text-gray-400 dark:text-gray-500"}`}>
                        {new Date(ev.dateEpochMs).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                      </span>
                      <span className={`text-xs truncate flex-1 ${isCurrent ? "text-purple-900 dark:text-purple-100 font-semibold" : "text-gray-700 dark:text-gray-200 font-medium"}`}>
                        {ev.headlinerName || "Show"}
                      </span>
                      <PriceWidget isFree={ev.isFree} isSoldOut={ev.status === "sold-out" || ev.tags?.includes("sold-out")} priceMin={ev.priceMin} priceMax={ev.priceMax} className="text-xs shrink-0" />
                    </Link>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>{/* end outer grid */}
    </ContentArea>
  );
};

export default EventDetailPage;
