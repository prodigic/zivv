/**
 * Venues directory page
 */

import React, { useEffect } from "react";
import { Link, useNavigate, useLocation } from "react-router-dom";
import { ContentArea } from "@/components/layout/AppShell.js";
import PriceWidget from "@/components/ui/PriceWidget.js";
import NewBadge from "@/components/ui/NewBadge.js";
import {
  VenueCardSkeleton,
  ListSkeleton,
} from "@/components/ui/LoadingSpinner.js";
import { useAppStore } from "@/stores/appStore.js";
import { useFilterStore } from "@/stores/filterStore.js";

const VenuesPage: React.FC = () => {
  const venues = useAppStore((state) => state.venues);
  const loading = useAppStore((state) => state.loading);
  const errors = useAppStore((state) => state.errors);
  const initialize = useAppStore((state) => state.initialize);
  const showUpcomingOnly = useAppStore((state) => state.showUpcomingOnly);
  const manifest = useAppStore((state) => state.manifest);

  const { filters, updateFilter, clearFilter } = useFilterStore();
  const navigate = useNavigate();
  const location = useLocation();

  const getInitialDisplayLimit = () => {
    const saved = sessionStorage.getItem("scroll-position-venues");
    if (saved) {
      return Math.max(30, Math.ceil(parseInt(saved, 10) / 300) + 30);
    }
    return 30;
  };

  const [venuesDisplayLimit, setVenuesDisplayLimit] = React.useState(getInitialDisplayLimit);
  const [venueSearch, setVenueSearch] = React.useState("");
  const [dateFilter, setDateFilter] = React.useState<string>("week"); // "all" | "week" | "month" | "YYYY-MM"
  const loadMoreRef = React.useRef<HTMLDivElement>(null);

  // Compute date window for the active filter
  const dateWindow = React.useMemo((): { start: number; end: number } | null => {
    const now = new Date();
    if (dateFilter === "all") return null;
    if (dateFilter === "week") {
      const end = new Date(now);
      end.setDate(now.getDate() + 7);
      end.setHours(23, 59, 59, 999);
      return { start: now.setHours(0, 0, 0, 0), end: end.getTime() };
    }
    if (dateFilter === "month") {
      // Today → end of current calendar month
      const end = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
      return { start: new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime(), end: end.getTime() };
    }
    // "YYYY-MM" — full calendar month from the 1st
    const [y, m] = dateFilter.split("-").map(Number);
    const start = new Date(y, m - 1, 1).getTime();
    const end = new Date(y, m, 0, 23, 59, 59, 999).getTime();
    return { start, end };
  }, [dateFilter]);

  // Derive available months from all venues, excluding current month (covered by "this month")
  const availableMonths = React.useMemo(() => {
    const now = new Date();
    const currentYM = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    const months = new Set<string>();
    venues.forEach((v) => v.upcomingEvents?.forEach((e) => {
      const d = new Date(e.dateEpochMs);
      const ym = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
      if (ym !== currentYM) months.add(ym);
    }));
    return [...months].sort();
  }, [venues]);

  React.useEffect(() => {
    if (filters.venues && filters.venues.length > 0) clearFilter("venues");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const mainElement = document.querySelector("main");
    if (!mainElement) return;
    const saved = sessionStorage.getItem("scroll-position-venues");
    if (saved) {
      const id = setTimeout(() => { mainElement.scrollTop = parseInt(saved, 10); }, 300);
      return () => clearTimeout(id);
    }
  }, [location.pathname]);

  useEffect(() => {
    const mainElement = document.querySelector("main");
    if (!mainElement) return;
    let t: NodeJS.Timeout;
    const onScroll = () => {
      clearTimeout(t);
      t = setTimeout(() => sessionStorage.setItem("scroll-position-venues", mainElement.scrollTop.toString()), 100);
    };
    mainElement.addEventListener("scroll", onScroll);
    return () => { mainElement.removeEventListener("scroll", onScroll); clearTimeout(t); };
  }, []);

  const handleVenueClick = (venueName: string) => {
    updateFilter("venues", [venueName]);
    navigate("/");
  };

  // Normalize messy city fragments to proper display names
  const normalizeCity = (city: string): string => {
    const c = city?.toLowerCase().trim() ?? "";
    if (c === "s.f" || c.startsWith("san francisco") || c === "sf") return "San Francisco";
    if (c === "oakland" || c.startsWith("west oakland")) return "Oakland";
    if (c === "berkeley" || c === "uc" || c.startsWith("uc berkeley")) return "Berkeley";
    if (c === "santa" || c.startsWith("santa cruz") || c.startsWith("santa rosa") || c.startsWith("santa clara")) {
      if (city.toLowerCase().includes("cruz") || ["the Blue Lagoon","the Catalyst","the Crepe Place","the Jury Room","Moe's Alley","Subrosa","the Rio Theater","the Vets Hall","the Shop"].some(n => n.toLowerCase().startsWith(c))) return "Santa Cruz";
      if (city.toLowerCase().includes("rosa") || c === "santa") return "Santa Rosa";
      return "Santa Clara";
    }
    if (c === "san" || c === "downtown") return "San Jose";
    if (c === "mountain" || c.startsWith("mountain view")) return "Mountain View";
    if (c === "golden") return "San Francisco";
    if (c === "rohnert" || c.startsWith("rohnert park")) return "Rohnert Park";
    if (c === "el" || c.startsWith("el cerrito")) return "El Cerrito";
    if (c === "daly" || c === "daily" || c.startsWith("daly city")) return "Daly City";
    if (c === "palo" || c.startsWith("palo alto") || c === "stanford") return "Palo Alto";
    if (c === "mill" || c.startsWith("mill valley")) return "Mill Valley";
    if (c === "walnut" || c.startsWith("walnut creek")) return "Walnut Creek";
    if (c === "south" || c === "west" || c === "town" || c === "19th") return "Other";
    if (c === "novato") return "Novato";
    if (c === "napa") return "Napa";
    if (c === "albany") return "Albany";
    if (c === "alameda") return "Alameda";
    if (c === "emeryville") return "Emeryville";
    if (c === "hayward") return "Hayward";
    if (c === "vallejo") return "Vallejo";
    if (c === "petaluma") return "Petaluma";
    if (c === "concord") return "Concord";
    if (c === "crockett") return "Crockett";
    if (c === "saratoga") return "Saratoga";
    if (c === "richmond" || c.startsWith("point richmond")) return "Richmond";
    if (c === "sonoma") return "Sonoma";
    if (c === "fairfield") return "Fairfield";
    if (c === "felton" || c === "salinas" || c === "pacifica" || c === "alviso" || c === "memlo" || c === "piedmont") return c.charAt(0).toUpperCase() + c.slice(1);
    // Numeric / junk → Other
    if (/^\d/.test(city)) return "Other";
    return city || "Other";
  };

  // Preferred city order
  const CITY_ORDER = [
    "San Francisco", "Oakland", "Berkeley", "San Jose",
    "Albany", "Emeryville", "Alameda", "Richmond", "El Cerrito",
    "Hayward", "Daly City", "Pacifica",
    "Santa Cruz", "Santa Rosa", "Santa Clara",
    "Mountain View", "Palo Alto", "Saratoga",
    "Napa", "Sonoma", "Petaluma", "Novato", "Rohnert Park",
    "Mill Valley", "Walnut Creek", "Concord", "Vallejo",
    "Crockett", "Fairfield", "Felton", "Salinas", "Memlo", "Piedmont",
    "Other",
  ];

  const allVenuesArray = React.useMemo(() => {
    let arr = Array.from(venues.values());

    if (showUpcomingOnly) {
      arr = arr.filter((v) => v.upcomingEvents.length > 0);
    }

    if (filters.cities && filters.cities.length > 0) {
      const cities = new Set(filters.cities);
      arr = arr.filter((v) => cities.has(v.city));
    }

    if (filters.ageRestrictions && filters.ageRestrictions.length > 0) {
      const ages = filters.ageRestrictions;
      arr = arr.filter((v) =>
        ages.some((r) => {
          const va = v.ageRestriction?.toLowerCase() ?? "";
          const fa = r.toLowerCase();
          if (fa === "all-ages" || fa === "all ages") return va.includes("all") || va.includes("a/a") || va === "all-ages";
          return va.includes(fa);
        })
      );
    }

    if (filters.dateRange?.startDate || filters.dateRange?.endDate) {
      const start = filters.dateRange?.startDate ? new Date(filters.dateRange.startDate).setHours(0,0,0,0) : -Infinity;
      const end = filters.dateRange?.endDate ? new Date(filters.dateRange.endDate).setHours(23,59,59,999) : Infinity;
      arr = arr.filter((v) => v.upcomingEvents.some((e) => e.dateEpochMs >= start && e.dateEpochMs <= end));
    }

    if (filters.dates && filters.dates.length > 0) {
      const selectedDates = new Set(filters.dates);
      arr = arr.filter((v) =>
        v.upcomingEvents.some((e) => selectedDates.has(new Date(e.dateEpochMs).toISOString().split("T")[0]))
      );
    }

    if (venueSearch.trim()) {
      const q = venueSearch.trim().toLowerCase();
      arr = arr.filter((v) => v.name.toLowerCase().includes(q));
    }

    // Filter by local date window (week / month / named month)
    if (dateWindow) {
      arr = arr.filter((v) =>
        v.upcomingEvents.some((e) => e.dateEpochMs >= dateWindow.start && e.dateEpochMs <= dateWindow.end)
      );
    }

    // Sort: by city order, then most shows in window, then alphabetical
    arr.sort((a, b) => {
      const ca = normalizeCity(a.city);
      const cb = normalizeCity(b.city);
      const oa = CITY_ORDER.indexOf(ca);
      const ob = CITY_ORDER.indexOf(cb);
      const cityA = oa === -1 ? 999 : oa;
      const cityB = ob === -1 ? 999 : ob;
      if (cityA !== cityB) return cityA - cityB;
      const countInWindow = (v: typeof a) =>
        dateWindow
          ? v.upcomingEvents.filter((e) => e.dateEpochMs >= dateWindow.start && e.dateEpochMs <= dateWindow.end).length
          : v.upcomingEvents.length;
      const na = countInWindow(a);
      const nb = countInWindow(b);
      if (nb !== na) return nb - na;
      return a.name.localeCompare(b.name);
    });

    return arr;
  }, [venues, showUpcomingOnly, filters.cities, filters.ageRestrictions, filters.dateRange, filters.dates, venueSearch, dateWindow]);

  React.useEffect(() => { setVenuesDisplayLimit(30); }, [venueSearch, dateFilter]);

  const venuesArray = allVenuesArray.slice(0, venuesDisplayLimit);

  React.useEffect(() => {
    const element = loadMoreRef.current;
    if (!element || allVenuesArray.length <= venuesDisplayLimit) return;
    const observer = new IntersectionObserver(
      (entries) => { if (entries[0].isIntersecting) setVenuesDisplayLimit((p) => p + 30); },
      { threshold: 0.1 }
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [allVenuesArray.length, venuesDisplayLimit]);

  useEffect(() => {
    if (venues.size === 0 && loading.venues === "idle" && !errors.venues) {
      initialize().catch(console.error);
    }
  }, [venues.size, loading.venues, errors.venues, initialize]);

  if (loading.venues === "loading") {
    return (
      <ContentArea title="Venues">
        <ListSkeleton count={10} itemSkeleton={VenueCardSkeleton} />
      </ContentArea>
    );
  }

  if (errors.venues) {
    return (
      <ContentArea title="Venues">
        <div className="text-center py-12">
          <h3 className="text-lg font-medium text-gray-900 dark:text-white mb-2">Unable to Load Venues</h3>
          <p className="text-gray-600 dark:text-gray-300">{errors.venues}</p>
        </div>
      </ContentArea>
    );
  }

  return (
    <ContentArea title="Venues" subtitle={`${allVenuesArray.length} venues across the Bay Area`}>
      {/* Search input */}
      <div className="relative mb-6">
        <svg className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
        </svg>
        <input
          type="text"
          value={venueSearch}
          onChange={(e) => setVenueSearch(e.target.value)}
          placeholder="Search venues..."
          className="w-full pl-9 pr-9 py-2 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded-lg text-sm text-gray-900 dark:text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-purple-500 focus:border-transparent"
        />
        {venueSearch && (
          <button onClick={() => setVenueSearch("")} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200">
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        )}
      </div>

      {/* Date filter bar */}
      <div className="flex flex-wrap gap-1.5 mb-4 -mt-2">
        {(["all", "week", "month"] as const).map((f) => (
          <button
            key={f}
            onClick={() => setDateFilter(f)}
            className={`px-2.5 py-1 rounded text-xs font-medium transition-colors ${
              dateFilter === f
                ? "bg-purple-600 text-white"
                : "bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600"
            }`}
          >
            {f === "all" ? "All" : f === "week" ? "This week" : "This month"}
          </button>
        ))}
        {availableMonths.map((ym) => {
          const [y, m] = ym.split("-").map(Number);
          const now = new Date();
          const sameYear = y === now.getFullYear();
          const label = new Date(y, m - 1, 1).toLocaleDateString("en-US", sameYear ? { month: "short" } : { month: "short", year: "2-digit" });
          return (
            <button
              key={ym}
              onClick={() => setDateFilter(ym)}
              className={`px-2.5 py-1 rounded text-xs font-medium transition-colors ${
                dateFilter === ym
                  ? "bg-purple-600 text-white"
                  : "bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600"
              }`}
            >
              {label}
            </button>
          );
        })}
      </div>

      {allVenuesArray.length === 0 && venueSearch && (
        <div className="text-center py-12 text-gray-500 dark:text-gray-400">
          No venues found matching &ldquo;{venueSearch}&rdquo;
        </div>
      )}

      <div className="space-y-8">
        {(() => {
          const groups: { city: string; venues: typeof venuesArray }[] = [];
          let lastCity = "";
          venuesArray.forEach((venue) => {
            const city = normalizeCity(venue.city);
            if (city !== lastCity) {
              groups.push({ city, venues: [] });
              lastCity = city;
            }
            groups[groups.length - 1].venues.push(venue);
          });
          return groups.map(({ city, venues: groupVenues }) => (
            <div key={city}>
              <div className="col-span-full flex items-center gap-3 mb-3">
                <span className="text-sm font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider">{city}</span>
                <div className="flex-1 h-px bg-gray-200 dark:bg-gray-700" />
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                {groupVenues.map((venue) => (
          <div
            key={venue.id}
            onClick={() => handleVenueClick(venue.name)}
            className={`venue-card ${venue.upcomingEvents.length === 0 ? "no-upcoming" : ""} bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-3 hover:shadow-md transition-shadow cursor-pointer`}
          >
            {/* Header */}
            <div className="flex items-center space-x-3 mb-2.5">
              <div className="h-10 w-10 bg-gradient-to-br from-blue-100 to-green-100 dark:from-blue-900 dark:to-green-900 rounded-full flex items-center justify-center shrink-0">
                <svg className="h-5 w-5 text-blue-600 dark:text-blue-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" />
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" />
                </svg>
              </div>
              <div className="flex-1 min-w-0">
                <h3 className="text-base font-semibold text-gray-900 dark:text-white truncate">{venue.name}</h3>
                <div className="text-xs text-gray-500 dark:text-gray-400">
                  {venue.city}
                  {venue.ageRestriction && <span className="ml-2 text-gray-400 dark:text-gray-500">· {venue.ageRestriction}</span>}
                  {(() => {
                    const count = dateWindow
                      ? venue.upcomingEvents.filter((e) => e.dateEpochMs >= dateWindow.start && e.dateEpochMs <= dateWindow.end).length
                      : venue.upcomingEvents.length;
                    return (
                      <span className="ml-2 text-gray-400 dark:text-gray-500">
                        · {count > 0 ? `${count} shows` : "no upcoming shows"}
                      </span>
                    );
                  })()}
                </div>
              </div>
            </div>

            {/* Compact event rows */}
            {(() => {
              const visibleEvents = dateWindow
                ? venue.upcomingEvents.filter((e) => e.dateEpochMs >= dateWindow.start && e.dateEpochMs <= dateWindow.end)
                : venue.upcomingEvents;
              return visibleEvents.length > 0 && (
              <div className="border-t border-gray-100 dark:border-gray-700 pt-1 space-y-0">
                {visibleEvents.map((event) => (
                  <Link
                    key={event.id}
                    to={`/events/${event.id}`}
                    onClick={(e) => e.stopPropagation()}
                    className="flex items-center gap-1.5 py-0.5 rounded hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
                  >
                    <span className="text-xs text-gray-400 dark:text-gray-500 w-14 shrink-0 tabular-nums">
                      {new Date(event.dateEpochMs).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                    </span>
                    <span className="text-xs text-gray-700 dark:text-gray-200 truncate font-medium flex-1">
                      {event.headlinerName || "Show"}
                    </span>
                    <PriceWidget isFree={event.isFree} priceMin={event.priceMin} priceMax={event.priceMax} className="text-xs shrink-0" />
                    {manifest?.latestIngestionDate && (
                      <NewBadge createdAtEpochMs={event.createdAtEpochMs} latestIngestionDate={manifest.latestIngestionDate} />
                    )}
                  </Link>
                ))}
              </div>
              );
            })()}
          </div>
        ))}
              </div>
            </div>
          ));
        })()}

        {allVenuesArray.length > venuesDisplayLimit && (
          <div ref={loadMoreRef} className="text-center py-6">
            <div className="inline-flex items-center space-x-2 text-gray-500 dark:text-gray-400">
              <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-gray-500"></div>
              <span className="text-sm">Loading more venues...</span>
            </div>
          </div>
        )}
      </div>
    </ContentArea>
  );
};

export default VenuesPage;
