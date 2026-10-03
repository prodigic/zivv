/**
 * Newsletter — Reddit-ready weekly digest of local act shows + newly announced events
 */

import React, { useEffect, useMemo, useRef, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { ContentArea } from "@/components/layout/AppShell.js";
import { useAppStore } from "@/stores/appStore.js";
import {
  DISCOVERY_TIME_ZONE,
  formatLocalDate,
  getLast7LocalDateWindow,
  isAddedInWindow,
  isEventUpcoming,
} from "@/lib/discovery.js";

const MAX_NAMES_SHOWN = 5;

interface CityConfig {
  label: string;
  match: (city: string) => boolean;
  /** Regional newsletters need a city on every listing. */
  showCity?: boolean;
  groups?: CityConfig[];
}

const SF_CITY: CityConfig = {
  label: "SF",
  match: (c) => /^(?:s\.?f\.?|san francisco)(?:,.*)?$/i.test(c.trim()),
};

const NEARBY_CITIES: CityConfig = {
  label: "Nearby",
  match: (c) => /^(?:oakland|berkeley|albany)(?:,.*)?$/i.test(c.trim()),
};

const CITY_CONFIGS: Record<string, CityConfig> = {
  "bay-area": {
    label: "Bay Area",
    match: () => true,
    showCity: true,
  },
  sf: SF_CITY,
  sfmusic: {
    label: "sfmusic",
    showCity: true,
    match: (c) => SF_CITY.match(c) || NEARBY_CITIES.match(c),
    groups: [
      { ...SF_CITY, label: "San Francisco Events" },
      { ...NEARBY_CITIES, label: "Nearby Events" },
    ],
  },
  oakland: {
    label: "Oakland",
    match: (c) => c.toLowerCase() === "oakland",
  },
  berkeley: {
    label: "Berkeley",
    match: (c) => c.toLowerCase() === "berkeley",
  },
  "santa-cruz": {
    label: "Santa Cruz",
    // VenueLineParser truncates to first word — "Santa Cruz" becomes "Santa"
    match: (c) => c === "Santa" || c.toLowerCase() === "santa cruz",
  },
  "east-bay": {
    label: "East Bay",
    showCity: true,
    match: (c) =>
      [
        "Oakland",
        "Berkeley",
        "Emeryville",
        "Albany",
        "El Cerrito",
        "Richmond",
      ].includes(c) || c.toLowerCase() === "emeryville",
  },
  "south-bay": {
    label: "South Bay",
    showCity: true,
    match: (c) =>
      [
        "San Jose",
        "Santa Clara",
        "Sunnyvale",
        "Mountain View",
        "Palo Alto",
        "Cupertino",
        "Milpitas",
        "Fremont",
      ].includes(c) ||
      c === "San" ||
      c.toLowerCase() === "san jose",
  },
  emeryville: {
    label: "Emeryville",
    match: (c) => c.toLowerCase() === "emeryville",
  },
  petaluma: {
    label: "Petaluma",
    match: (c) => c.toLowerCase() === "petaluma",
  },
};

function fmtDate(epochMs: number): string {
  return (
    formatLocalDate(
      epochMs,
      {
        weekday: "short",
        month: "short",
        day: "numeric",
      },
      DISCOVERY_TIME_ZONE
    ) ?? "Date TBA"
  );
}

function fmtPrice(
  priceMin?: number,
  priceMax?: number,
  isFree?: boolean
): string {
  if (isFree) return "free";
  if (!priceMin) return "";
  if (priceMax && priceMax !== priceMin) return `$${priceMin}–$${priceMax}`;
  return `$${priceMin}`;
}

function joinCapped(names: string[], cap = MAX_NAMES_SHOWN): string {
  if (names.length <= cap) return names.join(", ");
  return `${names.slice(0, cap).join(", ")}, ...and more`;
}

function sourceAttribution(
  events: Iterable<{
    firstImportedBy?: string;
    sources?: Array<{ kind?: string }>;
  }>
): string {
  const labels = new Set<string>();
  for (const event of events) {
    if (event.firstImportedBy === "steveslist")
      labels.add("Steve's List at https://www.stevelist.com/");
    if (event.firstImportedBy === "zivv-venue-import")
      labels.add("venue calendars");
    for (const source of event.sources ?? []) {
      if (source.kind === "steveslist")
        labels.add("Steve's List at https://www.stevelist.com/");
      if (source.kind === "venue-calendar") labels.add("venue calendars");
    }
  }
  return labels.size > 0
    ? [...labels].join(" and ")
    : "the loaded event sources";
}

const INLINE_MARKDOWN_PATTERN =
  /(\*\*[^*]+\*\*|~~[^~]+~~|\*[^*]+\*|https?:\/\/[^\s]+)/g;

function renderInlineMarkdown(value: string): React.ReactNode[] {
  return value
    .split(INLINE_MARKDOWN_PATTERN)
    .filter(Boolean)
    .map((part, index) => {
      if (part.startsWith("**") && part.endsWith("**")) {
        return <strong key={index}>{part.slice(2, -2)}</strong>;
      }
      if (part.startsWith("~~") && part.endsWith("~~")) {
        return <del key={index}>{part.slice(2, -2)}</del>;
      }
      if (part.startsWith("*") && part.endsWith("*")) {
        return <em key={index}>{part.slice(1, -1)}</em>;
      }
      if (/^https?:\/\//.test(part)) {
        return (
          <a
            key={index}
            href={part}
            target="_blank"
            rel="noreferrer"
            className="text-purple-600 underline hover:text-purple-700 dark:text-purple-400 dark:hover:text-purple-300"
          >
            {part}
          </a>
        );
      }
      return <React.Fragment key={index}>{part}</React.Fragment>;
    });
}

function MarkdownPreview({ markdown }: { markdown: string }) {
  return (
    <article className="w-full rounded-lg border border-gray-200 bg-white p-5 text-gray-800 shadow-sm dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200">
      {markdown.split(/\r?\n/).map((line, index) => {
        if (!line.trim())
          return <div key={index} className="h-2" aria-hidden="true" />;
        if (/^---+$/.test(line.trim())) {
          return (
            <hr
              key={index}
              className="my-4 border-gray-200 dark:border-gray-700"
            />
          );
        }

        const heading = line.match(/^(#{1,6})\s+(.*)$/);
        if (heading) {
          const level = heading[1].length;
          const className =
            level === 2
              ? "mb-2 text-2xl font-bold"
              : "mb-2 text-lg font-semibold";
          const children = renderInlineMarkdown(heading[2]);
          if (level === 1)
            return (
              <h1 key={index} className={className}>
                {children}
              </h1>
            );
          if (level === 2)
            return (
              <h2 key={index} className={className}>
                {children}
              </h2>
            );
          if (level === 4)
            return (
              <h4 key={index} className="mb-3 text-xl font-bold">
                {children}
              </h4>
            );
          return (
            <h3 key={index} className={className}>
              {children}
            </h3>
          );
        }

        if (line.startsWith("- ")) {
          return (
            <div key={index} className="mb-1 flex gap-2 pl-1 leading-relaxed">
              <span aria-hidden="true">•</span>
              <span>{renderInlineMarkdown(line.slice(2))}</span>
            </div>
          );
        }

        return (
          <p key={index} className="mb-2 leading-relaxed">
            {renderInlineMarkdown(line)}
          </p>
        );
      })}
    </article>
  );
}

export default function NewsletterPage() {
  const { city: citySlug = "sf" } = useParams<{ city?: string }>();
  const cityConfig = CITY_CONFIGS[citySlug] ?? CITY_CONFIGS.sf;
  const isCity = cityConfig.match;

  const {
    artists,
    events,
    venues,
    manifest,
    loading,
    errors,
    initialize,
    localArtistExclude,
    localArtistList,
  } = useAppStore();
  const loadedChunks = useAppStore((s) => s.loadedChunks);
  const loadChunk = useAppStore((s) => s.loadChunk);
  const [copied, setCopied] = useState(false);
  const [viewMode, setViewMode] = useState<"preview" | "raw">("preview");
  const [pendingChunkIds, setPendingChunkIds] = useState<Set<string>>(
    () => new Set()
  );
  const [chunkLoadError, setChunkLoadError] = useState<string | null>(null);
  const chunkRequestDatasetRef = useRef<string | null>(null);
  const requestedChunkIdsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (loading.artists === "idle") initialize().catch(console.error);
  }, [loading.artists, initialize]);

  // Newsletter membership and local-acts thresholds both use the complete
  // event set. Keep failed chunk ids requested so a rejected promise does not
  // trigger a render/retry loop while still making the failure visible.
  useEffect(() => {
    if (!manifest?.chunks?.events) return;
    const datasetKey = manifest.datasetVersion;
    if (chunkRequestDatasetRef.current !== datasetKey) {
      chunkRequestDatasetRef.current = datasetKey;
      requestedChunkIdsRef.current = new Set();
      setPendingChunkIds(new Set());
      setChunkLoadError(null);
    }

    const chunksToLoad = [
      ...new Set(manifest.chunks.events.map((chunk) => chunk.chunkId)),
    ].filter(
      (chunkId) =>
        !loadedChunks.has(chunkId) && !requestedChunkIdsRef.current.has(chunkId)
    );
    if (chunksToLoad.length === 0) return;

    for (const chunkId of chunksToLoad)
      requestedChunkIdsRef.current.add(chunkId);
    setPendingChunkIds((previous) => {
      const next = new Set(previous);
      for (const chunkId of chunksToLoad) next.add(chunkId);
      return next;
    });

    Promise.allSettled(chunksToLoad.map((chunkId) => loadChunk(chunkId))).then(
      (results) => {
        // Ignore an older dataset's completion after a refresh or manifest
        // replacement has started a new request set.
        if (chunkRequestDatasetRef.current !== datasetKey) return;
        const failure = results.find(
          (result): result is PromiseRejectedResult =>
            result.status === "rejected"
        );
        if (failure) {
          setChunkLoadError(
            failure.reason instanceof Error
              ? failure.reason.message
              : "Failed to load one or more event months."
          );
        }
        setPendingChunkIds((previous) => {
          const next = new Set(previous);
          for (const chunkId of chunksToLoad) next.delete(chunkId);
          return next;
        });
      }
    );
  }, [manifest, loadedChunks, loadChunk]);

  const nowMs = useMemo(() => Date.now(), []);
  const weekEndMs = useMemo(() => nowMs + 7 * 24 * 60 * 60 * 1000, [nowMs]);
  const fallbackAddedWindow = useMemo(
    () => getLast7LocalDateWindow(nowMs, DISCOVERY_TIME_ZONE),
    [nowMs]
  );
  const weeklyEdition = manifest?.weeklyEdition ?? null;
  const weekHeadingEpochMs = useMemo(() => {
    const editionId = weeklyEdition?.editionId;
    if (editionId && /^\d{4}-\d{2}-\d{2}$/u.test(editionId)) {
      const [year, month, day] = editionId.split("-").map(Number);
      // Edition IDs are the Friday publication date. Use midday UTC so the
      // date remains the same in the discovery timezone during DST.
      return Date.UTC(year, month - 1, day, 12);
    }
    return weeklyEdition?.endEpochMs ?? nowMs;
  }, [weeklyEdition, nowMs]);

  const artistMap = useMemo(() => {
    const m = new Map<number, string>();
    for (const a of artists.values()) m.set(a.id as number, a.name);
    return m;
  }, [artists]);

  const eventSourceAttribution = useMemo(
    () => sourceAttribution(events.values()),
    [events]
  );

  // Full lineup keyed by canonical event ID → artist names in bill order.
  const lineupMap = useMemo(() => {
    const m = new Map<number, string[]>();
    for (const ev of events.values()) {
      const key = Number(ev.id);
      if (!m.has(key)) {
        m.set(
          key,
          ev.artistIds
            .map((id) => artistMap.get(id as number) ?? "")
            .filter(Boolean)
        );
      }
    }
    return m;
  }, [events, artistMap]);

  // Geography is established by a recorded origin check, never show counts.
  const localArtistNames = useMemo(() => {
    const names = new Set<string>();
    for (const artist of artists.values()) {
      const normalizedName = artist.name.toLowerCase();
      if (localArtistExclude.has(normalizedName)) continue;
      const onList = localArtistList.has(normalizedName);
      if (onList) names.add(normalizedName);
    }
    return names;
  }, [artists, localArtistExclude, localArtistList]);

  // Local acts section — one row per physical show, not per artist. A bill
  // with multiple qualifying local acts (e.g. a big multi-band festival) is
  // still a single show, so it lists all of them together in one bolded
  // header instead of repeating the same venue/date under each act.
  const localShowRows = useMemo(() => {
    interface Row {
      eventId: number;
      dateEpochMs: number;
      venueId: number;
      venueName: string;
      venueCity: string;
      priceMin?: number;
      priceMax?: number;
      isFree?: boolean;
      isSoldOut?: boolean;
      multipleShow?: boolean;
      localNames: Set<string>;
    }
    const rows = new Map<number, Row>();

    for (const artist of artists.values()) {
      if (!localArtistNames.has(artist.name.toLowerCase())) continue;
      const upcoming = artist.upcomingEvents.filter((e) =>
        isEventUpcoming(e, nowMs, DISCOVERY_TIME_ZONE)
      );
      if (upcoming.length === 0) continue;

      const sfEvents = upcoming.filter(
        (e) => isCity(e.venueCity) && e.dateEpochMs <= weekEndMs
      );
      for (const ev of sfEvents) {
        const key = Number(ev.id);
        let row = rows.get(key);
        if (!row) {
          row = {
            eventId: key,
            dateEpochMs: ev.dateEpochMs,
            venueId: ev.venueId as number,
            venueName: ev.venueName,
            venueCity: ev.venueCity,
            priceMin: ev.priceMin,
            priceMax: ev.priceMax,
            isFree: ev.isFree,
            isSoldOut: ev.isSoldOut,
            multipleShow: events.get(ev.id)?.tags.includes("multiple-show"),
            localNames: new Set(),
          };
          rows.set(key, row);
        }
        row.localNames.add(artist.name);
      }
    }

    return [...rows.values()]
      .map((row) => {
        const fullLineup = lineupMap.get(row.eventId) ?? [];
        // Preserve bill order: locals in lineup order, then any local name
        // the lineup lookup missed (shouldn't normally happen).
        const localNames = fullLineup.filter((n) => row.localNames.has(n));
        for (const n of row.localNames)
          if (!localNames.includes(n)) localNames.push(n);
        const coActs = fullLineup.filter((n) => !row.localNames.has(n));
        return { ...row, localNames, coActs };
      })
      .sort((a, b) => a.dateEpochMs - b.dateEpochMs);
  }, [artists, events, localArtistNames, nowMs, weekEndMs, isCity, lineupMap]);

  // Build additions from the frozen weekly membership when available. The
  // membership is intentionally retained even when a show has already
  // happened by the time this page is opened; presentation marks that case
  // below instead of silently dropping it.
  const justAddedEvents = useMemo(() => {
    const editionIds = weeklyEdition?.eventIds;
    const editionIdSet = Array.isArray(editionIds)
      ? new Set(editionIds.map((id) => Number(id)))
      : null;

    return Array.from(events.values())
      .filter((e) => {
        const isInEdition = editionIdSet
          ? editionIdSet.has(Number(e.id))
          : weeklyEdition?.startEpochMs !== undefined &&
              weeklyEdition.endEpochMs !== undefined
            ? isAddedInWindow(e, {
                startEpochMs: weeklyEdition.startEpochMs,
                endEpochMs: weeklyEdition.endEpochMs,
              })
            : isAddedInWindow(e, fallbackAddedWindow);
        if (!isInEdition) return false;
        const venueCity = venues.get(e.venueId)?.city ?? "";
        return isCity(venueCity);
      })
      .sort((a, b) => {
        const aUpcoming = isEventUpcoming(a, nowMs, DISCOVERY_TIME_ZONE);
        const bUpcoming = isEventUpcoming(b, nowMs, DISCOVERY_TIME_ZONE);
        if (aUpcoming !== bUpcoming) return aUpcoming ? -1 : 1;
        return a.dateEpochMs - b.dateEpochMs;
      });
  }, [events, venues, weeklyEdition, fallbackAddedWindow, nowMs, isCity]);

  // All SF shows this week (section 3)
  const sfWeekEvents = useMemo(() => {
    return Array.from(events.values())
      .filter((e) => {
        if (
          !isEventUpcoming(e, nowMs, DISCOVERY_TIME_ZONE) ||
          e.dateEpochMs > weekEndMs
        )
          return false;
        const venueCity = venues.get(e.venueId)?.city ?? "";
        return isCity(venueCity);
      })
      .sort((a, b) => a.dateEpochMs - b.dateEpochMs);
  }, [events, venues, nowMs, weekEndMs, isCity]);

  // Distinct local acts appearing anywhere in this week's rows (for the summary line)
  const localActCount = useMemo(() => {
    const names = new Set<string>();
    for (const row of localShowRows)
      for (const n of row.localNames) names.add(n);
    return names.size;
  }, [localShowRows]);

  const text = useMemo(() => {
    const lines: string[] = [];
    const areaLabel = cityConfig.groups ? "SF & Nearby" : cityConfig.label;

    const venueLocation = (
      name: string,
      city: string,
      includeCity = cityConfig.showCity ?? false
    ) => {
      const label = city.trim();
      const cityLabel = label && !/^\d+$/.test(label) ? label : "City TBA";
      return includeCity ? `${name}, ${cityLabel}` : name;
    };

    function appendGroups<T>(
      rows: T[],
      getCity: (row: T) => string,
      emptyMessage: string,
      appendRow: (row: T) => void
    ) {
      for (const group of cityConfig.groups ?? [cityConfig]) {
        if (cityConfig.groups) lines.push(`#### ${group.label}`, "");
        const groupRows = cityConfig.groups
          ? rows.filter((row) => group.match(getCity(row)))
          : rows;
        if (groupRows.length === 0) lines.push(emptyMessage);
        else groupRows.forEach(appendRow);
        lines.push("");
      }
    }

    const weekStr =
      formatLocalDate(
        weekHeadingEpochMs,
        {
          month: "long",
          day: "numeric",
          year: "numeric",
        },
        DISCOVERY_TIME_ZONE
      ) ?? "this week";

    lines.push(`## ${cityConfig.label} Shows — Week of ${weekStr}`);
    lines.push("");

    // Section 1: Local acts
    lines.push("---");
    lines.push("");
    lines.push(`### 🏠 Local Acts Playing ${areaLabel} This Week`);
    lines.push("");

    appendGroups(
      localShowRows,
      (row) => row.venueCity,
      "*No verified local acts playing this week.*",
      (row) => {
        const price = fmtPrice(row.priceMin, row.priceMax, row.isFree);
        const pricePart = price ? ` · ${price}` : "";
        const soldOut = row.isSoldOut ? " ~~sold out~~" : "";
        const multiplePart = row.multipleShow ? " · Multiple shows" : "";
        const header = joinCapped(row.localNames);
        const withPart =
          row.coActs.length > 0 ? ` w/ · ${joinCapped(row.coActs)}` : "";
        lines.push(`**${header}**${withPart}`);
        lines.push(
          `- ${fmtDate(row.dateEpochMs)} · ${venueLocation(row.venueName, row.venueCity)}${pricePart}${soldOut}${multiplePart}`
        );
        lines.push("");
      }
    );

    // Section 2: Recently added shows. Keep all frozen edition membership and mark
    // rows whose performance has already happened at render time.
    lines.push("---");
    lines.push("");
    lines.push("### ✦ Recently added shows");
    lines.push("");

    appendGroups(
      justAddedEvents,
      (ev) => venues.get(ev.venueId)?.city ?? "",
      "*No additions this week.*",
      (ev) => {
        const headlinerName =
          artistMap.get(ev.headlinerArtistId as number) ?? "";
        const venueName = venues.get(ev.venueId)?.name ?? "";
        const venueCity = (venues.get(ev.venueId)?.city ?? "").trim();
        const price = fmtPrice(ev.priceMin, ev.priceMax, ev.isFree);
        const pricePart = price ? ` · ${price}` : "";
        const agePart =
          ev.ageRestriction && ev.ageRestriction !== "all-ages"
            ? ` · ${ev.ageRestriction}`
            : "";
        const soldOut =
          ev.status === "sold-out" || ev.tags?.includes("sold-out")
            ? " ~~sold out~~"
            : "";
        const multiplePart = ev.tags?.includes("multiple-show")
          ? " · Multiple shows"
          : "";
        const happened = isEventUpcoming(ev, nowMs, DISCOVERY_TIME_ZONE)
          ? ""
          : " · already happened";
        lines.push(
          `- ${fmtDate(ev.dateEpochMs)} · **${headlinerName}** at ${venueLocation(venueName, venueCity, true)}${pricePart}${agePart}${soldOut}${multiplePart}${happened}`
        );
      }
    );
    lines.push("");

    // Section 3: All SF shows this week
    lines.push("---");
    lines.push("");
    lines.push(`### 📍 All ${areaLabel} Shows This Week`);
    lines.push("");

    appendGroups(
      sfWeekEvents,
      (ev) => venues.get(ev.venueId)?.city ?? "",
      `*No ${cityConfig.label} shows found for this week.*`,
      (ev) => {
        const venueName = venues.get(ev.venueId)?.name ?? "";
        const venueCity = venues.get(ev.venueId)?.city ?? "";
        const lineup =
          lineupMap.get(Number(ev.id)) ??
          [artistMap.get(ev.headlinerArtistId as number) ?? ""].filter(Boolean);
        const price = fmtPrice(ev.priceMin, ev.priceMax, ev.isFree);
        const pricePart = price ? ` · ${price}` : "";
        const agePart =
          ev.ageRestriction && ev.ageRestriction !== "all-ages"
            ? ` · ${ev.ageRestriction}`
            : "";
        const soldOut =
          ev.status === "sold-out" || ev.tags?.includes("sold-out")
            ? " ~~sold out~~"
            : "";
        const multiplePart = ev.tags?.includes("multiple-show")
          ? " · Multiple shows"
          : "";
        const lineupText = lineup
          .map((name) =>
            localArtistNames.has(name.toLowerCase()) ? `**${name}**` : name
          )
          .join(", ");
        lines.push(
          `- ${fmtDate(ev.dateEpochMs)} · ${lineupText} at ${venueLocation(venueName, venueCity)}${pricePart}${agePart}${soldOut}${multiplePart}`
        );
      }
    );

    lines.push("");
    lines.push(`-- event data sourced from ${eventSourceAttribution}`);
    lines.push("");

    return lines.join("\n");
  }, [
    localShowRows,
    justAddedEvents,
    sfWeekEvents,
    artistMap,
    lineupMap,
    localArtistNames,
    venues,
    nowMs,
    weekHeadingEpochMs,
    eventSourceAttribution,
    cityConfig,
  ]);

  const requiredChunkIds = useMemo(
    () =>
      manifest?.chunks?.events
        ? [...new Set(manifest.chunks.events.map((chunk) => chunk.chunkId))]
        : [],
    [manifest?.chunks?.events]
  );
  const allRequiredChunksLoaded = requiredChunkIds.every((chunkId) =>
    loadedChunks.has(chunkId)
  );
  const newsletterError =
    errors.manifest ||
    errors.artists ||
    errors.venues ||
    errors.events ||
    chunkLoadError;
  const isLoading =
    !manifest ||
    loading.manifest === "loading" ||
    loading.artists === "loading" ||
    loading.venues === "loading" ||
    loading.events === "loading" ||
    pendingChunkIds.size > 0 ||
    (!allRequiredChunksLoaded && !newsletterError);
  const canCopy = !isLoading && !newsletterError;

  const handleCopy = () => {
    if (!canCopy) return;
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <ContentArea
      title="Newsletter"
      subtitle={`${cityConfig.label} · local acts + recently added shows · Reddit-ready`}
    >
      {newsletterError && (
        <div
          role="alert"
          className="mb-5 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-200"
        >
          <div className="font-semibold">Unable to load newsletter events</div>
          <div>{newsletterError}</div>
        </div>
      )}

      {isLoading && !newsletterError && (
        <div className="text-center py-12">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-purple-600 mx-auto mb-4" />
          <p className="text-sm text-gray-500 dark:text-gray-400">Loading…</p>
        </div>
      )}

      {!isLoading && !newsletterError && (
        <>
          <div className="flex flex-wrap gap-1.5 mb-4">
            {Object.entries(CITY_CONFIGS).map(([slug, cfg]) => (
              <Link
                key={slug}
                to={slug === "sf" ? "/newsletter" : `/newsletter/${slug}`}
                aria-current={cityConfig === cfg ? "page" : undefined}
                className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${
                  citySlug === slug ||
                  (slug === "sf" && !CITY_CONFIGS[citySlug])
                    ? "bg-purple-600 text-white"
                    : "bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600"
                }`}
              >
                {cfg.label}
              </Link>
            ))}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
            <div className="text-sm text-gray-500 dark:text-gray-400">
              {localActCount} local acts · {justAddedEvents.length} recently
              added shows · {sfWeekEvents.length}{" "}
              {cityConfig.groups ? "SF & Nearby" : cityConfig.label} shows this
              week
            </div>
            <div className="flex items-center gap-2">
              <div
                className="inline-flex rounded-md border border-gray-200 bg-gray-100 p-0.5 dark:border-gray-700 dark:bg-gray-800"
                role="group"
                aria-label="Newsletter display mode"
              >
                {(["preview", "raw"] as const).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    aria-pressed={viewMode === mode}
                    onClick={() => setViewMode(mode)}
                    className={`rounded px-2.5 py-1 text-xs font-medium capitalize transition-colors ${
                      viewMode === mode
                        ? "bg-white text-gray-900 shadow-sm dark:bg-gray-700 dark:text-white"
                        : "text-gray-500 hover:text-gray-800 dark:text-gray-400 dark:hover:text-gray-200"
                    }`}
                  >
                    {mode}
                  </button>
                ))}
              </div>
              <button
                onClick={handleCopy}
                disabled={!canCopy}
                className="flex items-center gap-1.5 rounded-md bg-purple-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-purple-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {copied ? (
                  <>
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
                        d="M5 13l4 4L19 7"
                      />
                    </svg>
                    Copied!
                  </>
                ) : (
                  <>
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
                        d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-1M8 5a2 2 0 002 2h2a2 2 0 002-2M8 5a2 2 0 012-2h2a2 2 0 012 2m0 0h2a2 2 0 012 2v3m2 4H10m0 0l3-3m-3 3l3 3"
                      />
                    </svg>
                    Copy for Reddit
                  </>
                )}
              </button>
            </div>
          </div>

          {viewMode === "preview" ? (
            <MarkdownPreview markdown={text} />
          ) : (
            <textarea
              readOnly
              value={text}
              className="w-full font-mono text-xs bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-lg p-4 text-gray-800 dark:text-gray-200 resize-none focus:outline-none focus:ring-2 focus:ring-purple-500"
              style={{ minHeight: "70vh" }}
              onClick={(e) => (e.target as HTMLTextAreaElement).select()}
            />
          )}
        </>
      )}
    </ContentArea>
  );
}
