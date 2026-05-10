/**
 * Just Added page — events from the most recent ETL ingestion run
 */

import React, { useEffect } from "react";
import { Link } from "react-router-dom";
import { ContentArea } from "@/components/layout/AppShell.js";
import PriceWidget from "@/components/ui/PriceWidget.js";
import { useAppStore } from "@/stores/appStore.js";

const NewEventsPage: React.FC = () => {
  const events = useAppStore((s) => s.events);
  const artists = useAppStore((s) => s.artists);
  const venues = useAppStore((s) => s.venues);
  const manifest = useAppStore((s) => s.manifest);
  const loadedChunks = useAppStore((s) => s.loadedChunks);
  const loadChunk = useAppStore((s) => s.loadChunk);
  const initialize = useAppStore((s) => s.initialize);
  const loading = useAppStore((s) => s.loading);

  const [displayLimit, setDisplayLimit] = React.useState(100);
  const loadMoreRef = React.useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (loading.artists === "idle") initialize().catch(console.error);
  }, [loading.artists, initialize]);

  // Load all chunks to find new events across all months
  useEffect(() => {
    if (!manifest?.chunks?.events) return;
    manifest.chunks.events.forEach((c) => {
      if (!loadedChunks.has(c.chunkId)) loadChunk(c.chunkId).catch(() => {});
    });
  }, [manifest, loadedChunks, loadChunk]);

  // Show events whose createdAtEpochMs (UTC date) matches manifest.latestIngestionDate
  const { justAdded, runDate } = React.useMemo(() => {
    const ingestDate = manifest?.latestIngestionDate ?? null;
    if (events.size === 0 || !ingestDate) return { justAdded: [], runDate: null };

    const justAdded = Array.from(events.values())
      .filter((e) => {
        const createdDay = new Date(e.createdAtEpochMs).toISOString().split("T")[0];
        return createdDay === ingestDate && e.dateEpochMs > Date.now();
      })
      .sort((a, b) => a.dateEpochMs - b.dateEpochMs);

    return { justAdded, runDate: ingestDate };
  }, [events, manifest]);

  React.useEffect(() => {
    const el = loadMoreRef.current;
    if (!el || justAdded.length <= displayLimit) return;
    const observer = new IntersectionObserver(
      (entries) => { if (entries[0].isIntersecting) setDisplayLimit((p) => p + 100); },
      { threshold: 0.1 }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [justAdded.length, displayLimit]);

  const runDateStr = runDate
    ? new Date(runDate).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })
    : "";

  return (
    <ContentArea
      title="Just Added"
      subtitle={runDate ? `${justAdded.length} events added ${runDateStr}` : ""}
    >
      {loading.events === "loading" && justAdded.length === 0 && (
        <div className="text-center py-12">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-purple-600 mx-auto mb-4" />
          <p className="text-sm text-gray-500 dark:text-gray-400">Loading…</p>
        </div>
      )}

      {justAdded.length === 0 && loading.events !== "loading" && (
        <div className="text-center py-12 text-gray-500 dark:text-gray-400">No recently added events found.</div>
      )}

      <div className="space-y-0">
        {justAdded.slice(0, displayLimit).map((event) => {
          const headliner = event.headlinerArtistId ? artists.get(event.headlinerArtistId) : null;
          const venue = event.venueId ? venues.get(event.venueId) : null;
          const d = new Date(event.dateEpochMs);
          const otherCount = event.artistIds.length - 1;

          return (
            <Link
              key={event.id}
              to={`/events/${event.slug}`}
              className="block px-2 py-1.5 rounded hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
            >
              <div className="flex items-baseline gap-2 min-w-0">
                <span className="text-xs text-gray-400 dark:text-gray-500 w-14 shrink-0 tabular-nums">
                  {d.toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                </span>
                <span className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate min-w-0">
                  {headliner?.name ?? "Show"}
                  {otherCount > 0 && <span className="text-gray-400 dark:text-gray-500 font-normal text-xs"> +{otherCount}</span>}
                </span>
              </div>
              <div className="flex items-baseline gap-2 min-w-0">
                <span className="w-14 shrink-0">
                  <PriceWidget isFree={event.isFree} isSoldOut={event.isSoldOut} priceMin={event.priceMin} priceMax={event.priceMax} className="text-xs" />
                </span>
                <span className="text-xs text-gray-500 dark:text-gray-400 truncate min-w-0">
                  {venue?.name ?? ""}
                </span>
              </div>
            </Link>
          );
        })}

        {justAdded.length > displayLimit && (
          <div ref={loadMoreRef} className="text-center py-6">
            <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-gray-500 mx-auto" />
          </div>
        )}
      </div>
    </ContentArea>
  );
};

export default NewEventsPage;
