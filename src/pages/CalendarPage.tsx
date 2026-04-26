/**
 * Calendar page — single-column day cards with compact event rows
 */

import React, { useEffect } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ContentArea } from "@/components/layout/AppShell.js";
import PriceWidget from "@/components/ui/PriceWidget.js";
import NewBadge from "@/components/ui/NewBadge.js";
import { useAppStore } from "@/stores/appStore.js";
import { useFilterStore } from "@/stores/filterStore.js";
import { DatePagination } from "@/components/ui/DatePagination.js";

interface CalendarPageProps {
  view: "month" | "week" | "agenda";
}

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// City color map — bg for button fill, text for venue label
const CITY_COLORS: Record<string, { bg: string; text: string }> = {
  "San Francisco": { bg: "bg-rose-600",    text: "text-rose-500 dark:text-rose-400" },
  "Oakland":       { bg: "bg-amber-600",   text: "text-amber-500 dark:text-amber-400" },
  "Berkeley":      { bg: "bg-green-600",   text: "text-green-500 dark:text-green-400" },
  "San Jose":      { bg: "bg-sky-600",     text: "text-sky-500 dark:text-sky-400" },
  "Santa Rosa":    { bg: "bg-violet-600",  text: "text-violet-500 dark:text-violet-400" },
  "Napa":          { bg: "bg-pink-600",    text: "text-pink-500 dark:text-pink-400" },
  "Petaluma":      { bg: "bg-teal-600",    text: "text-teal-500 dark:text-teal-400" },
  "Felton":        { bg: "bg-lime-600",    text: "text-lime-500 dark:text-lime-400" },
  "Santa Cruz":    { bg: "bg-cyan-600",    text: "text-cyan-500 dark:text-cyan-400" },
  "Other":         { bg: "bg-gray-500",    text: "text-gray-500 dark:text-gray-400" },
};

function normalizeCityName(city: string): string {
  const c = city?.toLowerCase().trim() ?? "";
  if (c === "s.f" || c.startsWith("san francisco") || c === "sf") return "San Francisco";
  if (c === "oakland" || c.startsWith("west oakland")) return "Oakland";
  if (c === "berkeley" || c === "uc" || c.startsWith("uc berkeley")) return "Berkeley";
  if (c === "santa cruz") return "Santa Cruz";
  if (c === "santa") return "Santa Rosa";
  if (c === "san" || c === "downtown") return "San Jose";
  if (c === "mountain") return "Mountain View";
  if (c === "golden") return "San Francisco";
  if (c === "rohnert") return "Rohnert Park";
  if (c === "el") return "El Cerrito";
  if (c === "daly" || c === "daily") return "Daly City";
  if (c === "palo" || c === "stanford") return "Palo Alto";
  if (c === "mill") return "Mill Valley";
  if (c === "walnut") return "Walnut Creek";
  if (/^\d/.test(city) || ["south","west","town","19th"].includes(c)) return "Other";
  if (["novato","napa","albany","alameda","emeryville","hayward","vallejo","petaluma","concord","crockett","saratoga","richmond","sonoma","fairfield","felton","salinas","pacifica","alviso","piedmont"].includes(c)) return c.charAt(0).toUpperCase() + c.slice(1);
  return city || "Other";
}
const FULL_DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];


const CalendarPage: React.FC<CalendarPageProps> = () => {
  const events = useAppStore((state) => state.events);
  const artists = useAppStore((state) => state.artists);
  const venues = useAppStore((state) => state.venues);
  const loading = useAppStore((state) => state.loading);
  const manifest = useAppStore((state) => state.manifest);
  const initialize = useAppStore((state) => state.initialize);
  const loadChunk = useAppStore((state) => state.loadChunk);
  const loadedChunks = useAppStore((state) => state.loadedChunks);

  const { filters, updateFilter } = useFilterStore();
  const navigate = useNavigate();

  const goToVenue = (venueName: string, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    updateFilter("venues", [venueName]);
    navigate("/");
  };
  const [selectedCities, setSelectedCities] = React.useState<Set<string>>(new Set());
  const loadMoreRef = React.useRef<HTMLDivElement>(null);
  const [displayDays, setDisplayDays] = React.useState(14);

  const ALLOWED_CITIES = ["San Francisco", "Oakland", "Berkeley", "San Jose", "Santa Cruz", "Other"];

  // Load chunks needed for the current date range
  useEffect(() => {
    if (!manifest?.chunks?.events) return;
    const parseLocal = (s: string) => { const [y,m,d] = s.split("-").map(Number); return new Date(y,m-1,d); };
    const start = filters.dateRange?.startDate ? parseLocal(filters.dateRange.startDate).getTime() : null;
    const end = filters.dateRange?.endDate ? parseLocal(filters.dateRange.endDate).setHours(23,59,59,999) : null;
    const chunksNeeded = manifest.chunks.events
      .filter((c) => {
        const [y, m] = c.chunkId.split("-").map(Number);
        const chunkStart = new Date(y, m - 1, 1).getTime();
        const chunkEnd = new Date(y, m, 0, 23, 59, 59, 999).getTime();
        if (start && end) return chunkStart <= end && chunkEnd >= start;
        return true;
      })
      .map((c) => c.chunkId)
      .filter((id) => !loadedChunks.has(id));
    chunksNeeded.forEach((id) => loadChunk(id).catch(() => {}));
  }, [filters.dateRange, manifest, loadedChunks, loadChunk]);

  // Initialize
  useEffect(() => {
    if (loading.artists === "idle") initialize().catch(console.error);
  }, [loading.artists, initialize]);

  // Reset display days when filter changes
  React.useEffect(() => { setDisplayDays(14); }, [filters.dateRange, selectedCities]);

  // Build day-grouped events
  const dayGroups = React.useMemo(() => {
    const now = new Date();
    const todayMs = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const parseLocal = (s: string) => { const [y,m,d] = s.split("-").map(Number); return new Date(y,m-1,d); };
    const rangeStart = filters.dateRange?.startDate ? parseLocal(filters.dateRange.startDate).setHours(0,0,0,0) : todayMs;
    const rangeEnd = filters.dateRange?.endDate ? parseLocal(filters.dateRange.endDate).setHours(23,59,59,999) : Infinity;

    let filtered = Array.from(events.values()).filter((e) => {
      if (e.dateEpochMs < todayMs) return false;
      if (e.dateEpochMs < rangeStart || e.dateEpochMs > rangeEnd) return false;
      if (selectedCities.size > 0) {
        const venue = venues.get(e.venueId);
        const city = normalizeCityName(venue?.city ?? "");
        if (!selectedCities.has(city)) return false;
      }
      return true;
    });

    filtered.sort((a, b) => a.dateEpochMs - b.dateEpochMs);

    const groups = new Map<string, typeof filtered>();
    filtered.forEach((e) => {
      const d = e.date; // "YYYY-MM-DD"
      if (!groups.has(d)) groups.set(d, []);
      groups.get(d)!.push(e);
    });

    return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [events, venues, filters.dateRange, selectedCities]);

  const visibleDays = dayGroups.slice(0, displayDays);

  // Infinite scroll
  React.useEffect(() => {
    const el = loadMoreRef.current;
    if (!el || dayGroups.length <= displayDays) return;
    const observer = new IntersectionObserver(
      (entries) => { if (entries[0].isIntersecting) setDisplayDays((p) => p + 14); },
      { threshold: 0.1 }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [dayGroups.length, displayDays]);

  const isLoading = loading.events === "loading" || loading.artists === "loading";

  return (
    <ContentArea title="Calendar" subtitle={`${dayGroups.length} days with shows`}>

      {/* City filter bar */}
      <div className="flex flex-wrap gap-1.5 mb-4 -mt-2">
          {ALLOWED_CITIES.map((city) => {
            const active = selectedCities.has(city);
            const colors = CITY_COLORS[city] ?? CITY_COLORS["Other"];
            return (
              <button
                key={city}
                onClick={() => setSelectedCities((prev) => {
                  const next = new Set(prev);
                  if (active) next.delete(city); else next.add(city);
                  return next;
                })}
                className={`px-2.5 py-1 rounded text-xs font-medium transition-colors ${
                  active
                    ? `${colors.bg} text-white`
                    : `bg-gray-100 dark:bg-gray-700 ${colors.text} hover:bg-gray-200 dark:hover:bg-gray-600`
                }`}
              >
                {city}
              </button>
            );
          })}
          {selectedCities.size > 0 && (
            <button onClick={() => setSelectedCities(new Set())} className="px-2.5 py-1 rounded text-xs font-medium text-gray-400 hover:text-gray-600 dark:hover:text-gray-200">
              Clear
            </button>
          )}
      </div>

      {/* Date range slider */}
      <DatePagination className="mb-4" />

      {isLoading && events.size === 0 && (
        <div className="text-center py-12 text-gray-500 dark:text-gray-400">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-purple-600 mx-auto mb-4" />
          Loading events…
        </div>
      )}

      {!isLoading && dayGroups.length === 0 && (
        <div className="text-center py-12 text-gray-500 dark:text-gray-400">
          No shows found for this period.
        </div>
      )}

      {/* Day cards — 2 column grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 items-stretch">
        {visibleDays.map(([date, dayEvents]) => {
          const d = new Date(date + "T12:00:00");
          const now = new Date();
          const localToday = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,"0")}-${String(now.getDate()).padStart(2,"0")}`;
          const isToday = date === localToday;
          const isWeekend = d.getDay() === 0 || d.getDay() === 6;
          const dayOfWeek = FULL_DAY_NAMES[d.getDay()];
          const dayOfWeekShort = DAY_NAMES[d.getDay()];

          const venueIds = new Set(dayEvents.map((e) => e.venueId));
          const freeCount = dayEvents.filter((e) => e.isFree).length;

          // Badge colors
          const badgeBg = isToday
            ? "bg-purple-600"
            : isWeekend
            ? "bg-blue-500"
            : "bg-gray-500 dark:bg-gray-600";

          return (
            <div
              key={date}
              className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-3 h-full"
            >
              {/* Day header */}
              <div className="flex items-center gap-3 mb-2">
                <div className={`text-center w-10 shrink-0 rounded ${badgeBg}`}>
                  <div className="text-xs font-bold uppercase pt-0.5 text-white/70">
                    {dayOfWeekShort}
                  </div>
                  <div className="text-lg font-bold leading-tight pb-0.5 text-white">
                    {d.getDate()}
                  </div>
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-semibold text-gray-900 dark:text-white">
                    {isToday ? "Today" : dayOfWeek},{" "}
                    {d.toLocaleDateString("en-US", { month: "long", day: "numeric" })}
                  </div>
                  <div className="text-xs text-gray-400 dark:text-gray-500">
                    {dayEvents.length} show{dayEvents.length !== 1 ? "s" : ""} · {venueIds.size} venue{venueIds.size !== 1 ? "s" : ""}
                    {freeCount > 0 && ` · ${freeCount} free`}
                  </div>
                </div>
              </div>

              {/* Event rows */}
              <div className="border-t border-gray-100 dark:border-gray-700 pt-1 space-y-0">
                {dayEvents.map((event) => {
                  const headliner = event.headlinerArtistId ? artists.get(event.headlinerArtistId) : null;
                  const venue = event.venueId ? venues.get(event.venueId) : null;
                  const venueCity = normalizeCityName(venue?.city ?? "");
                  const venueColors = CITY_COLORS[venueCity] ?? CITY_COLORS["Other"];
                  const otherCount = event.artistIds.length - 1;

                  return (
                    <Link
                      key={event.id}
                      to={`/events/${event.slug}`}
                      className="flex items-center gap-1.5 py-0.5 rounded hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors group"
                    >
                      {/* Time */}
                      <span className="text-xs text-gray-400 dark:text-gray-500 w-14 shrink-0 tabular-nums">
                        {event.startTimeEpochMs
                          ? new Date(event.startTimeEpochMs).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })
                          : "TBA"}
                      </span>
                      {/* Artist */}
                      <span className="text-xs font-medium text-gray-900 dark:text-gray-100 truncate flex-1">
                        {headliner?.name ?? "Show"}
                        {otherCount > 0 && (
                          <span className="text-gray-400 dark:text-gray-500 font-normal"> +{otherCount}</span>
                        )}
                      </span>
                      {/* Venue */}
                      <button
                        onClick={(e) => venue && goToVenue(venue.name, e)}
                        className={`text-xs truncate max-w-[120px] shrink-0 font-medium text-left hover:underline ${venueColors.text}`}
                      >
                        {venue?.name ?? ""}
                      </button>
                      {/* Price */}
                      <PriceWidget
                        isFree={event.isFree}
                        isSoldOut={event.status === "sold-out" || event.tags?.includes("sold-out")}
                        priceMin={event.priceMin}
                        priceMax={event.priceMax}
                        className="text-xs shrink-0"
                      />
                      {manifest?.latestIngestionDate && (
                        <NewBadge createdAtEpochMs={event.createdAtEpochMs} latestIngestionDate={manifest.latestIngestionDate} />
                      )}
                    </Link>
                  );
                })}
              </div>
            </div>
          );
        })}

        {dayGroups.length > displayDays && (
          <div ref={loadMoreRef} className="col-span-full text-center py-6">
            <div className="inline-flex items-center space-x-2 text-gray-500 dark:text-gray-400">
              <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-gray-500" />
              <span className="text-sm">Loading more days…</span>
            </div>
          </div>
        )}
      </div>
    </ContentArea>
  );
};

export default CalendarPage;
