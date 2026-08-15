/**
 * Newsletter — Reddit-ready weekly digest of local act shows + newly announced events
 */

import React, { useEffect, useMemo, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { ContentArea } from "@/components/layout/AppShell.js";
import { useAppStore } from "@/stores/appStore.js";

const MIN_EVENTS = 3;
const MIN_VENUES = 2;
const MAX_NAMES_SHOWN = 5;

interface CityConfig {
  label: string;
  match: (city: string) => boolean;
}

const CITY_CONFIGS: Record<string, CityConfig> = {
  sf: {
    label: "SF",
    match: (c) =>
      ["S.f", "San Francisco", "SF", "S.F."].includes(c) ||
      c.toLowerCase().includes("francisco"),
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
  const [y, m, d] = new Date(epochMs)
    .toISOString()
    .split("T")[0]
    .split("-")
    .map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
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
    initialize,
    localArtistExclude,
    localArtistList,
  } = useAppStore();
  const loadedChunks = useAppStore((s) => s.loadedChunks);
  const loadChunk = useAppStore((s) => s.loadChunk);
  const [copied, setCopied] = useState(false);
  const [viewMode, setViewMode] = useState<"preview" | "raw">("preview");

  useEffect(() => {
    if (loading.artists === "idle") initialize().catch(console.error);
  }, [loading.artists, initialize]);

  // Load all chunks
  useEffect(() => {
    if (!manifest?.chunks?.events) return;
    manifest.chunks.events.forEach((c) => {
      if (!loadedChunks.has(c.chunkId)) loadChunk(c.chunkId).catch(() => {});
    });
  }, [manifest, loadedChunks, loadChunk]);

  const ingestDate = manifest?.latestIngestionDate ?? null;

  const nowMs = useMemo(() => Date.now(), []);
  const weekEndMs = useMemo(() => nowMs + 7 * 24 * 60 * 60 * 1000, [nowMs]);

  const artistMap = useMemo(() => {
    const m = new Map<number, string>();
    for (const a of artists.values()) m.set(a.id as number, a.name);
    return m;
  }, [artists]);

  // Full lineup keyed by "dateEpochMs:venueId" → artist names in bill order
  const lineupMap = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const ev of events.values()) {
      const key = `${ev.dateEpochMs}:${ev.venueId}`;
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

  // Local acts section — one row per physical show, not per artist. A bill
  // with multiple qualifying local acts (e.g. a big multi-band festival) is
  // still a single show, so it lists all of them together in one bolded
  // header instead of repeating the same venue/date under each act.
  const localShowRows = useMemo(() => {
    interface Row {
      dateEpochMs: number;
      venueId: number;
      venueName: string;
      priceMin?: number;
      priceMax?: number;
      isFree?: boolean;
      isSoldOut?: boolean;
      localNames: Set<string>;
    }
    const rows = new Map<string, Row>();

    for (const artist of artists.values()) {
      if (localArtistExclude.has(artist.name.toLowerCase())) continue;
      const upcoming = artist.upcomingEvents.filter(
        (e) => e.dateEpochMs > nowMs
      );
      if (upcoming.length === 0) continue;
      const venueCount = new Set(upcoming.map((e) => e.venueId)).size;
      const onList = localArtistList.has(artist.name.toLowerCase());
      const meetsThreshold =
        upcoming.length >= MIN_EVENTS && venueCount >= MIN_VENUES;
      if (!onList && !meetsThreshold) continue;

      const sfEvents = upcoming.filter(
        (e) => isCity(e.venueCity) && e.dateEpochMs <= weekEndMs
      );
      for (const ev of sfEvents) {
        const key = `${ev.dateEpochMs}:${ev.venueId}`;
        let row = rows.get(key);
        if (!row) {
          row = {
            dateEpochMs: ev.dateEpochMs,
            venueId: ev.venueId as number,
            venueName: ev.venueName,
            priceMin: ev.priceMin,
            priceMax: ev.priceMax,
            isFree: ev.isFree,
            isSoldOut: ev.isSoldOut,
            localNames: new Set(),
          };
          rows.set(key, row);
        }
        row.localNames.add(artist.name);
      }
    }

    return [...rows.values()]
      .map((row) => {
        const key = `${row.dateEpochMs}:${row.venueId}`;
        const fullLineup = lineupMap.get(key) ?? [];
        // Preserve bill order: locals in lineup order, then any local name
        // the lineup lookup missed (shouldn't normally happen).
        const localNames = fullLineup.filter((n) => row.localNames.has(n));
        for (const n of row.localNames)
          if (!localNames.includes(n)) localNames.push(n);
        const coActs = fullLineup.filter((n) => !row.localNames.has(n));
        return { ...row, localNames, coActs };
      })
      .sort((a, b) => a.dateEpochMs - b.dateEpochMs);
  }, [
    artists,
    localArtistExclude,
    localArtistList,
    nowMs,
    weekEndMs,
    isCity,
    lineupMap,
  ]);

  // Just-added section — all SF newly announced, any future date
  const justAddedEvents = useMemo(() => {
    if (!ingestDate) return [];
    return Array.from(events.values())
      .filter((e) => {
        const day = new Date(e.createdAtEpochMs).toISOString().split("T")[0];
        if (day !== ingestDate || e.dateEpochMs <= nowMs) return false;
        const venueCity = venues.get(e.venueId)?.city ?? "";
        return isCity(venueCity);
      })
      .sort((a, b) => a.dateEpochMs - b.dateEpochMs);
  }, [events, venues, ingestDate, nowMs, isCity]);

  // All SF shows this week (section 3)
  const sfWeekEvents = useMemo(() => {
    return Array.from(events.values())
      .filter((e) => {
        if (e.dateEpochMs <= nowMs || e.dateEpochMs > weekEndMs) return false;
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

    const today = new Date();
    const [y, m, d] = today.toISOString().split("T")[0].split("-").map(Number);
    const weekStr = new Date(y, m - 1, d).toLocaleDateString("en-US", {
      month: "long",
      day: "numeric",
      year: "numeric",
    });

    lines.push(`## ${cityConfig.label} Shows — Week of ${weekStr}`);
    lines.push("");

    // Section 1: Local acts
    lines.push("---");
    lines.push("");
    lines.push(`### 🏠 Local Acts Playing ${cityConfig.label} This Week`);
    lines.push("");

    if (localShowRows.length === 0) {
      lines.push("*No local acts with 3+ shows across 2+ venues this week.*");
    } else {
      for (const row of localShowRows) {
        const price = fmtPrice(row.priceMin, row.priceMax, row.isFree);
        const pricePart = price ? ` · ${price}` : "";
        const soldOut = row.isSoldOut ? " ~~sold out~~" : "";
        const header = joinCapped(row.localNames);
        const withPart =
          row.coActs.length > 0 ? ` w/ · ${joinCapped(row.coActs)}` : "";
        lines.push(`**${header}**${withPart}`);
        lines.push(
          `- ${fmtDate(row.dateEpochMs)} · ${row.venueName}${pricePart}${soldOut}`
        );
        lines.push("");
      }
    }

    // Section 2: Just added
    if (ingestDate) {
      const [iy, im, id2] = ingestDate.split("-").map(Number);
      const ingestStr = new Date(iy, im - 1, id2).toLocaleDateString("en-US", {
        month: "long",
        day: "numeric",
      });

      lines.push("---");
      lines.push("");
      lines.push(`### ✦ Newly Announced (added ${ingestStr})`);
      lines.push("");

      if (justAddedEvents.length === 0) {
        lines.push("*No new events this week.*");
      } else {
        for (const ev of justAddedEvents) {
          const headlinerName =
            artistMap.get(ev.headlinerArtistId as number) ?? "";
          const venueName = venues.get(ev.venueId)?.name ?? "";
          const venueCity = venues.get(ev.venueId)?.city ?? "";
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
          lines.push(
            `- ${fmtDate(ev.dateEpochMs)} · **${headlinerName}** at ${venueName}, ${venueCity}${pricePart}${agePart}${soldOut}`
          );
        }
      }
      lines.push("");
    }

    // Section 3: All SF shows this week
    lines.push("---");
    lines.push("");
    lines.push(`### 📍 All ${cityConfig.label} Shows This Week`);
    lines.push("");

    if (sfWeekEvents.length === 0) {
      lines.push("*No SF shows found for this week.*");
    } else {
      for (const ev of sfWeekEvents) {
        const venueName = venues.get(ev.venueId)?.name ?? "";
        const lineup =
          lineupMap.get(`${ev.dateEpochMs}:${ev.venueId}`) ??
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
        lines.push(
          `- ${fmtDate(ev.dateEpochMs)} · **${lineup.join(", ")}** at ${venueName}${pricePart}${agePart}${soldOut}`
        );
      }
    }

    lines.push("");
    lines.push("-- event data sourced from https://www.stevelist.com/");
    lines.push("");

    return lines.join("\n");
  }, [
    localShowRows,
    justAddedEvents,
    sfWeekEvents,
    artistMap,
    lineupMap,
    venues,
    ingestDate,
    cityConfig,
  ]);

  const handleCopy = () => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  const isLoading =
    loading.artists === "loading" || loading.events === "loading";

  return (
    <ContentArea
      title="Newsletter"
      subtitle={`${cityConfig.label} · local acts + newly announced · Reddit-ready`}
    >
      {isLoading && (
        <div className="text-center py-12">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-purple-600 mx-auto mb-4" />
          <p className="text-sm text-gray-500 dark:text-gray-400">Loading…</p>
        </div>
      )}

      {!isLoading && (
        <>
          <div className="flex flex-wrap gap-1.5 mb-4">
            {Object.entries(CITY_CONFIGS).map(([slug, cfg]) => (
              <Link
                key={slug}
                to={slug === "sf" ? "/newsletter" : `/newsletter/${slug}`}
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
              {localActCount} local acts · {justAddedEvents.length} newly
              announced · {sfWeekEvents.length} SF shows this week
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
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium bg-purple-600 hover:bg-purple-700 text-white transition-colors"
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
