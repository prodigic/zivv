/**
 * Home page - Event list with infinite scroll
 */

import React, { useEffect, useCallback } from "react";
import { Link, useLocation } from "react-router-dom";
import { ContentArea } from "@/components/layout/AppShell.tsx";
import { useAppStore } from "@/stores/appStore.ts";
import { useFilterStore } from "@/stores/filterStore.ts";
import PriceWidget from "@/components/ui/PriceWidget.tsx";

const HomePage: React.FC = () => {
  const getAllEvents = useAppStore((state) => state.getAllEvents);
  const events = useAppStore((state) => state.events); // subscribe to events map for memo reactivity
  const getVenue = useAppStore((state) => state.getVenue);
  const getArtist = useAppStore((state) => state.getArtist);
  const loading = useAppStore((state) => state.loading);
  const errors = useAppStore((state) => state.errors);
  const loadChunk = useAppStore((state) => state.loadChunk);
  const initialize = useAppStore((state) => state.initialize);
  const artists = useAppStore((state) => state.artists);
  const showUpcomingOnly = useAppStore((state) => state.showUpcomingOnly);
  const manifest = useAppStore((state) => state.manifest);

  const { filters, searchQuery } = useFilterStore();
  const location = useLocation();

  const [displayLimit, setDisplayLimit] = React.useState(100);
  const loadMoreRef = React.useRef<HTMLDivElement>(null);

  // Scroll restoration
  useEffect(() => {
    const mainElement = document.querySelector("main");
    if (!mainElement) return;
    const saved = sessionStorage.getItem("scroll-position-home");
    if (saved) {
      const id = setTimeout(() => { mainElement.scrollTop = parseInt(saved, 10); }, 150);
      return () => clearTimeout(id);
    }
  }, [location.pathname]);

  useEffect(() => {
    const mainElement = document.querySelector("main");
    if (!mainElement) return;
    let t: NodeJS.Timeout;
    const handler = () => {
      clearTimeout(t);
      t = setTimeout(() => sessionStorage.setItem("scroll-position-home", mainElement.scrollTop.toString()), 100);
    };
    mainElement.addEventListener("scroll", handler);
    return () => { mainElement.removeEventListener("scroll", handler); clearTimeout(t); };
  }, []);

  // Filter events
  const allFilteredEvents = React.useMemo(() => {
    let evs = getAllEvents(Infinity);

    if (showUpcomingOnly) {
      const todayMs = new Date().setHours(0, 0, 0, 0);
      evs = evs.filter((e) => e.dateEpochMs >= todayMs);
    }
    if (filters.cities?.length) {
      const cities = new Set(filters.cities);
      evs = evs.filter((e) => { const v = getVenue(e.venueId); return v && cities.has(v.city); });
    }
    if (filters.dates?.length) {
      const dates = new Set(filters.dates);
      evs = evs.filter((e) => dates.has(new Date(e.dateEpochMs).toISOString().split("T")[0]));
    }
    if (filters.dateRange?.startDate || filters.dateRange?.endDate) {
      const parseLocal = (s: string) => { const [y,m,d] = s.split("-").map(Number); return new Date(y,m-1,d); };
      const start = filters.dateRange?.startDate ? parseLocal(filters.dateRange.startDate).setHours(0,0,0,0) : -Infinity;
      const end = filters.dateRange?.endDate ? parseLocal(filters.dateRange.endDate).setHours(23,59,59,999) : Infinity;
      evs = evs.filter((e) => e.dateEpochMs >= start && e.dateEpochMs <= end);
    }
    if (filters.venues?.length) {
      const venues = new Set(filters.venues);
      evs = evs.filter((e) => { const v = getVenue(e.venueId); return v && venues.has(v.name); });
    }
    if (filters.isFree) {
      evs = evs.filter((e) => e.isFree);
    } else if (filters.priceRange?.min !== undefined || filters.priceRange?.max !== undefined) {
      evs = evs.filter((e) => {
        if (e.isFree) return (filters.priceRange?.min ?? 0) === 0;
        const p = e.priceMin ?? 0;
        if (filters.priceRange?.min !== undefined && p < filters.priceRange.min) return false;
        if (filters.priceRange?.max !== undefined && p > filters.priceRange.max) return false;
        return true;
      });
    }
    if (filters.ageRestrictions?.length) {
      const ages = filters.ageRestrictions;
      evs = evs.filter((e) => ages.some((r) => {
        const ea = (e.ageRestriction ?? "").toLowerCase();
        if (r === "all-ages") return ea.includes("all") || ea === "all-ages";
        return ea.includes(r.toLowerCase());
      }));
    }
    if (filters.tags?.length) {
      const tags = filters.tags;
      evs = evs.filter((e) => e.tags?.length && tags.some((t) => e.tags?.includes(t)));
    }
    if (searchQuery?.trim()) {
      const q = searchQuery.toLowerCase().trim();
      evs = evs.filter((e) => {
        if (getArtist(e.headlinerArtistId)?.name.toLowerCase().includes(q)) return true;
        if (e.artistIds?.some((id) => getArtist(id)?.name.toLowerCase().includes(q))) return true;
        if (getVenue(e.venueId)?.name.toLowerCase().includes(q)) return true;
        return false;
      });
    }
    return evs;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [events, showUpcomingOnly, filters, searchQuery]); // events map triggers recompute when chunks load

  // Initialize + load chunks
  useEffect(() => {
    const load = async () => {
      if (artists.size === 0 && loading.artists === "idle" && !errors.artists) {
        await initialize();
      }
      if (manifest?.chunks?.events) {
        await Promise.all(manifest.chunks.events.slice(0, 6).map((c) => loadChunk(c.chunkId)));
      }
    };
    if ((artists.size === 0 && loading.artists === "idle") || (allFilteredEvents.length === 0 && loading.events === "idle")) {
      load().catch(console.error);
    }
  }, [artists.size, loading.artists, loading.events, errors.artists, errors.events, initialize, loadChunk, manifest, allFilteredEvents.length]);

  // Infinite scroll
  const handleLoadMore = useCallback(async () => {
    if (loading.events === "loading") return;
    if (displayLimit < allFilteredEvents.length) {
      setDisplayLimit((p) => p + 100);
      return;
    }
    const lastEvent = getAllEvents(Infinity).at(-1);
    if (lastEvent) {
      const next = new Date(lastEvent.dateEpochMs);
      next.setMonth(next.getMonth() + 1);
      const chunkId = `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, "0")}`;
      await loadChunk(chunkId);
      setDisplayLimit((p) => p + 100);
    }
  }, [loading.events, displayLimit, allFilteredEvents.length, getAllEvents, loadChunk]);

  useEffect(() => {
    const el = loadMoreRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      (entries) => { if (entries[0].isIntersecting) handleLoadMore(); },
      { threshold: 0.1 }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [handleLoadMore]);

  const visibleEvents = allFilteredEvents.slice(0, displayLimit);

  if (loading.events === "loading" && allFilteredEvents.length === 0) {
    return (
      <ContentArea>
        <div className="text-center py-16">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-purple-600 mx-auto" />
        </div>
      </ContentArea>
    );
  }

  if (errors.events) {
    return (
      <ContentArea>
        <div className="text-center py-12">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-2">Unable to load events</h3>
          <p className="text-gray-600 dark:text-gray-400 mb-4">{errors.events}</p>
          <button onClick={() => loadChunk(manifest?.chunks?.events?.[0]?.chunkId ?? "2026-04")}
            className="px-4 py-2 bg-purple-600 text-white rounded-lg text-sm">Try Again</button>
        </div>
      </ContentArea>
    );
  }

  return (
    <ContentArea title="Upcoming Shows" subtitle={`${allFilteredEvents.length} events`}>
      {allFilteredEvents.length === 0 && (
        <div className="text-center py-12 text-gray-500 dark:text-gray-400">No events match your filters.</div>
      )}

      <div className="space-y-0">
        {visibleEvents.map((event) => {
          const headliner = getArtist(event.headlinerArtistId);
          const venue = getVenue(event.venueId);
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
                  {d.toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                </span>
                <span className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate min-w-0">
                  {headliner?.name ?? "Show"}
                  {otherCount > 0 && <span className="text-gray-400 dark:text-gray-500 font-normal text-xs"> +{otherCount}</span>}
                </span>
              </div>
              <div className="flex items-baseline gap-2 min-w-0">
                <span className="w-14 shrink-0">
                  <PriceWidget isFree={event.isFree} isSoldOut={event.status === "sold-out" || event.tags?.includes("sold-out")} priceMin={event.priceMin} priceMax={event.priceMax} className="text-xs" />
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
