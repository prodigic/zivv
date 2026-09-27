/**
 * Home page - Event list with infinite scroll
 */

import React, { useEffect, useCallback } from "react";
import { Link, useLocation } from "react-router-dom";
import { ContentArea } from "@/components/layout/AppShell.tsx";
import { useAppStore } from "@/stores/appStore.ts";
import { useFilterStore } from "@/stores/filterStore.ts";
import PriceWidget from "@/components/ui/PriceWidget.tsx";
import NewBadge from "@/components/ui/NewBadge.tsx";
import { isEventUpcoming, localDateKey } from "@/lib/discovery.ts";

const HomePage: React.FC = () => {
  const events = useAppStore((state) => state.events); // subscribe to events map for memo reactivity
  const loadChunk = useAppStore((state) => state.loadChunk);
  const artists = useAppStore((state) => state.artists);
  const venues = useAppStore((state) => state.venues);
  const showUpcomingOnly = useAppStore((state) => state.showUpcomingOnly);
  const manifest = useAppStore((state) => state.manifest);

  const { filters, searchQuery } = useFilterStore();
  const location = useLocation();

  const [displayLimit, setDisplayLimit] = React.useState(100);
  const loadMoreRef = React.useRef<HTMLDivElement>(null);
  const nowMs = React.useMemo(() => Date.now(), []);
  const [chunksLoading, setChunksLoading] = React.useState(true);
  const [chunkLoadError, setChunkLoadError] = React.useState<string | null>(
    null
  );
  const [retryCount, setRetryCount] = React.useState(0);
  const requiredChunkIds = React.useMemo(() => {
    const currentMonth = localDateKey(nowMs)?.slice(0, 7) ?? "";
    return (manifest?.chunks.events ?? [])
      .map((chunk) => chunk.chunkId)
      .filter((id) => !showUpcomingOnly || id >= currentMonth)
      .sort();
  }, [manifest, showUpcomingOnly, nowMs]);

  // The shell loads the manifest before this page mounts. Load the actual
  // current/future months, including gaps and distant dates, before deciding
  // that a filtered list is empty. Past visits must not suppress this load.
  useEffect(() => {
    if (!manifest) return;
    let cancelled = false;
    setChunksLoading(true);
    setChunkLoadError(null);
    Promise.allSettled(requiredChunkIds.map((id) => loadChunk(id))).then(
      (results) => {
        if (cancelled) return;
        const failure = results.find((result) => result.status === "rejected");
        if (failure?.status === "rejected") {
          setChunkLoadError(
            failure.reason instanceof Error
              ? failure.reason.message
              : "Failed to load events."
          );
        }
        setChunksLoading(false);
      }
    );
    return () => {
      cancelled = true;
    };
  }, [manifest, requiredChunkIds, loadChunk, retryCount]);

  // Scroll restoration
  useEffect(() => {
    const mainElement = document.querySelector("main");
    if (!mainElement) return;
    const saved = sessionStorage.getItem("scroll-position-home");
    if (saved) {
      const id = setTimeout(() => {
        mainElement.scrollTop = parseInt(saved, 10);
      }, 150);
      return () => clearTimeout(id);
    }
  }, [location.pathname]);

  useEffect(() => {
    const mainElement = document.querySelector("main");
    if (!mainElement) return;
    let t: NodeJS.Timeout;
    const handler = () => {
      clearTimeout(t);
      t = setTimeout(
        () =>
          sessionStorage.setItem(
            "scroll-position-home",
            mainElement.scrollTop.toString()
          ),
        100
      );
    };
    mainElement.addEventListener("scroll", handler);
    return () => {
      mainElement.removeEventListener("scroll", handler);
      clearTimeout(t);
    };
  }, []);

  // Filter events
  const allFilteredEvents = React.useMemo(() => {
    let evs = Array.from(events.values()).sort(
      (a, b) => a.dateEpochMs - b.dateEpochMs
    );

    if (showUpcomingOnly) {
      evs = evs.filter((e) => isEventUpcoming(e, nowMs));
    }
    if (filters.cities?.length) {
      const cities = new Set(filters.cities);
      evs = evs.filter((e) => {
        const v = venues.get(e.venueId);
        return v && cities.has(v.city);
      });
    }
    if (filters.dates?.length) {
      const dates = new Set(filters.dates);
      evs = evs.filter((e) =>
        dates.has(new Date(e.dateEpochMs).toISOString().split("T")[0])
      );
    }
    if (filters.dateRange?.startDate || filters.dateRange?.endDate) {
      const parseLocal = (s: string) => {
        const [y, m, d] = s.split("-").map(Number);
        return new Date(y, m - 1, d);
      };
      const start = filters.dateRange?.startDate
        ? parseLocal(filters.dateRange.startDate).setHours(0, 0, 0, 0)
        : -Infinity;
      const end = filters.dateRange?.endDate
        ? parseLocal(filters.dateRange.endDate).setHours(23, 59, 59, 999)
        : Infinity;
      evs = evs.filter((e) => e.dateEpochMs >= start && e.dateEpochMs <= end);
    }
    if (filters.venues?.length) {
      const selectedVenues = new Set(filters.venues);
      evs = evs.filter((e) => {
        const v = venues.get(e.venueId);
        return v && selectedVenues.has(v.name);
      });
    }
    if (filters.isFree) {
      evs = evs.filter((e) => e.isFree);
    } else if (
      filters.priceRange?.min !== undefined ||
      filters.priceRange?.max !== undefined
    ) {
      evs = evs.filter((e) => {
        if (e.isFree) return (filters.priceRange?.min ?? 0) === 0;
        const p = e.priceMin ?? 0;
        if (filters.priceRange?.min !== undefined && p < filters.priceRange.min)
          return false;
        if (filters.priceRange?.max !== undefined && p > filters.priceRange.max)
          return false;
        return true;
      });
    }
    if (filters.ageRestrictions?.length) {
      const ages = filters.ageRestrictions;
      evs = evs.filter((e) =>
        ages.some((r) => {
          const ea = (e.ageRestriction ?? "").toLowerCase();
          if (r === "all-ages") return ea.includes("all") || ea === "all-ages";
          return ea.includes(r.toLowerCase());
        })
      );
    }
    if (filters.tags?.length) {
      const tags = filters.tags;
      evs = evs.filter(
        (e) => e.tags?.length && tags.some((t) => e.tags?.includes(t))
      );
    }
    if (searchQuery?.trim()) {
      const q = searchQuery.toLowerCase().trim();
      evs = evs.filter((e) => {
        if (artists.get(e.headlinerArtistId)?.name.toLowerCase().includes(q))
          return true;
        if (
          e.artistIds?.some((id) =>
            artists.get(id)?.name.toLowerCase().includes(q)
          )
        )
          return true;
        if (venues.get(e.venueId)?.name.toLowerCase().includes(q)) return true;
        return false;
      });
    }
    return evs;
  }, [events, artists, venues, showUpcomingOnly, filters, searchQuery, nowMs]);

  // Infinite scroll
  const handleLoadMore = useCallback(() => {
    setDisplayLimit((previous) =>
      Math.min(previous + 100, allFilteredEvents.length)
    );
  }, [allFilteredEvents.length]);

  useEffect(() => {
    const el = loadMoreRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) handleLoadMore();
      },
      { threshold: 0.1 }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [handleLoadMore, chunksLoading, chunkLoadError]);

  const visibleEvents = allFilteredEvents.slice(0, displayLimit);

  if (chunksLoading) {
    return (
      <ContentArea>
        <div
          role="status"
          aria-label="Loading events"
          className="text-center py-16"
        >
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-purple-600 mx-auto" />
          <span className="sr-only">Loading events…</span>
        </div>
      </ContentArea>
    );
  }

  if (chunkLoadError) {
    return (
      <ContentArea>
        <div className="text-center py-12">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-2">
            Unable to load events
          </h3>
          <p className="text-gray-600 dark:text-gray-400 mb-4">
            {chunkLoadError}
          </p>
          <button
            onClick={() => setRetryCount((count) => count + 1)}
            className="px-4 py-2 bg-purple-600 text-white rounded-lg text-sm"
          >
            Try Again
          </button>
        </div>
      </ContentArea>
    );
  }

  return (
    <ContentArea
      title="Upcoming Shows"
      subtitle={`${allFilteredEvents.length} events`}
    >
      {allFilteredEvents.length === 0 && (
        <div className="text-center py-12 text-gray-500 dark:text-gray-400">
          No events match your filters.
        </div>
      )}

      <div className="space-y-0">
        {visibleEvents.map((event) => {
          const headliner = artists.get(event.headlinerArtistId);
          const venue = venues.get(event.venueId);
          const otherCount = event.artistIds.length - 1;
          const d = new Date(event.dateEpochMs);

          return (
            <Link
              key={event.id}
              to={`/events/${event.slug}`}
              className="block px-2 py-1.5 rounded hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
            >
              <div className="flex items-baseline gap-2 min-w-0">
                <span className="text-xs text-gray-400 dark:text-gray-500 w-14 shrink-0 tabular-nums">
                  {d.toLocaleDateString("en-US", {
                    month: "short",
                    day: "numeric",
                  })}
                </span>
                <span className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate min-w-0">
                  {headliner?.name ?? "Show"}
                  {otherCount > 0 && (
                    <span className="text-gray-400 dark:text-gray-500 font-normal text-xs">
                      {" "}
                      +{otherCount}
                    </span>
                  )}
                </span>
                <NewBadge
                  createdAtEpochMs={event.createdAtEpochMs}
                  addedDateProvenance={event.addedDateProvenance}
                  nowMs={nowMs}
                />
              </div>
              <div className="flex items-baseline gap-2 min-w-0">
                <span className="w-14 shrink-0">
                  <PriceWidget
                    isFree={event.isFree}
                    isSoldOut={
                      event.status === "sold-out" ||
                      event.tags?.includes("sold-out")
                    }
                    priceMin={event.priceMin}
                    priceMax={event.priceMax}
                    className="text-xs"
                  />
                </span>
                <span className="text-xs text-gray-500 dark:text-gray-400 truncate min-w-0">
                  {venue?.name ?? ""}
                </span>
              </div>
            </Link>
          );
        })}

        {allFilteredEvents.length > displayLimit && (
          <div ref={loadMoreRef} className="text-center py-6">
            <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-gray-500 mx-auto" />
          </div>
        )}
      </div>
    </ContentArea>
  );
};

export default HomePage;
