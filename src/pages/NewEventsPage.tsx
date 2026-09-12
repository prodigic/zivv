/**
 * Just Added — source-aware events discovered in a local date-added window.
 */

import React, { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { ContentArea } from "@/components/layout/AppShell.js";
import PriceWidget from "@/components/ui/PriceWidget.js";
import { useAppStore } from "@/stores/appStore.js";
import {
  DISCOVERY_TIME_ZONE,
  formatAddedDateLabel,
  formatLocalDate,
  getLocalDateWindow,
  isAddedInWindow,
  isEventUpcoming,
  matchesSourceFilters,
  sortNewestAddedFirst,
  type DateWindowPreset,
  type DiscoveryEventLike,
  type DiscoverySourceFilters,
  type LocalDateWindow,
} from "@/lib/discovery.js";
import type { Event } from "@/types/events.js";
import type { RecentAdditionsIndex } from "@/types/data.js";

type RecentAddition = RecentAdditionsIndex["events"][number];

const SOURCE_LABELS: Record<string, string> = {
  steveslist: "Steve's List",
  "zivv-venue-import": "Zivv venue import",
  "venue-calendar": "Venue calendar",
};

function sourceLabel(source: string | null | undefined): string {
  return source ? (SOURCE_LABELS[source] ?? source) : "Unknown";
}

function eventDiscoveryData(
  event: Event,
  recent: RecentAddition | undefined
): DiscoveryEventLike {
  return {
    ...event,
    createdAtEpochMs: recent?.createdAtEpochMs ?? event.createdAtEpochMs,
    addedDateProvenance:
      recent?.addedDateProvenance ?? event.addedDateProvenance,
    firstImportedBy: recent?.firstImportedBy ?? event.firstImportedBy,
    sources: event.sources,
    date: event.date,
    dateEpochMs: event.dateEpochMs,
    startTimeEpochMs: event.startTimeEpochMs,
    timeBasis: event.timeBasis,
  };
}

function listSourceKinds(
  event: DiscoveryEventLike,
  recent: RecentAddition | undefined
): string[] {
  const eventKinds = (event.sources ?? [])
    .map((source) => source.kind)
    .filter((kind): kind is string => typeof kind === "string");
  return [...new Set([...eventKinds, ...(recent?.sourceKinds ?? [])])];
}

const NewEventsPage: React.FC = () => {
  const events = useAppStore((s) => s.events);
  const artists = useAppStore((s) => s.artists);
  const venues = useAppStore((s) => s.venues);
  const manifest = useAppStore((s) => s.manifest);
  const loadedChunks = useAppStore((s) => s.loadedChunks);
  const loadChunk = useAppStore((s) => s.loadChunk);
  const initialize = useAppStore((s) => s.initialize);
  const loading = useAppStore((s) => s.loading);
  const errors = useAppStore((s) => s.errors);
  const recentAdditions = useAppStore((s) => s.recentAdditions);
  const loadRecentAdditions = useAppStore((s) => s.loadRecentAdditions);

  const [displayLimit, setDisplayLimit] = useState(100);
  const [datePreset, setDatePreset] = useState<DateWindowPreset>("last7days");
  const [customStartDate, setCustomStartDate] = useState("");
  const [customEndDate, setCustomEndDate] = useState("");
  const [firstImportedBy, setFirstImportedBy] = useState("");
  const [listedBy, setListedBy] = useState("");
  const [recentIndexState, setRecentIndexState] = useState<
    "idle" | "loading" | "success" | "error"
  >("idle");
  const [recentIndexError, setRecentIndexError] = useState<string | null>(null);
  const [pendingChunkIds, setPendingChunkIds] = useState<Set<string>>(
    () => new Set()
  );
  const [chunkLoadError, setChunkLoadError] = useState<string | null>(null);
  const loadMoreRef = useRef<HTMLDivElement>(null);
  const recentRequestKeyRef = useRef<string | null>(null);
  const chunkRequestDatasetRef = useRef<string | null>(null);
  const requestedChunkIdsRef = useRef<Set<string>>(new Set());
  const nowMs = useMemo(() => Date.now(), []);

  useEffect(() => {
    if (loading.artists === "idle") initialize().catch(console.error);
  }, [loading.artists, initialize]);

  const recentIndexInfo = manifest?.chunks?.recentAdditions;
  const recentIndexMatchesDataset = Boolean(
    recentAdditions &&
    manifest &&
    recentAdditions.datasetVersion === manifest.datasetVersion
  );
  const recentIndexKey = recentIndexInfo
    ? `${manifest?.datasetVersion ?? ""}:${recentIndexInfo.filename}`
    : "legacy-manifest";

  // The new index is fetched through the store so it shares DataService's
  // version/cache behavior. A legacy manifest has no index and is handled by
  // the full-chunk fallback below.
  useEffect(() => {
    if (!recentIndexInfo) {
      recentRequestKeyRef.current = recentIndexKey;
      setRecentIndexState("success");
      setRecentIndexError(null);
      return;
    }
    if (recentIndexMatchesDataset) {
      recentRequestKeyRef.current = recentIndexKey;
      setRecentIndexState("success");
      setRecentIndexError(null);
      return;
    }
    if (recentRequestKeyRef.current === recentIndexKey) return;

    recentRequestKeyRef.current = recentIndexKey;
    setRecentIndexState("loading");
    setRecentIndexError(null);
    if (!loadRecentAdditions) {
      setRecentIndexState("error");
      setRecentIndexError(
        "This dataset advertises a recent-additions index, but it cannot be loaded."
      );
      return;
    }

    loadRecentAdditions()
      .then(() => {
        // The store action owns the parsed value. If it completed without
        // publishing one, the page must show an error instead of a false zero.
        const loaded = useAppStore.getState().recentAdditions;
        const matchesDataset =
          loaded?.datasetVersion === manifest?.datasetVersion;
        if (!loaded || !matchesDataset) {
          setRecentIndexState("error");
          setRecentIndexError(
            "The recent-additions index was empty or did not match this dataset."
          );
          return;
        }
        setRecentIndexState("success");
      })
      .catch((error: unknown) => {
        setRecentIndexState("error");
        setRecentIndexError(
          error instanceof Error
            ? error.message
            : "Failed to load recent additions."
        );
      });
  }, [
    loadRecentAdditions,
    recentAdditions,
    recentIndexMatchesDataset,
    recentIndexInfo,
    recentIndexKey,
    manifest?.datasetVersion,
  ]);

  const dateWindow = useMemo<LocalDateWindow | null>(() => {
    if (datePreset === "custom") {
      return getLocalDateWindow("custom", {
        startDate: customStartDate,
        endDate: customEndDate,
        nowMs,
        timeZone: DISCOVERY_TIME_ZONE,
      });
    }
    return getLocalDateWindow(datePreset, {
      nowMs,
      timeZone: DISCOVERY_TIME_ZONE,
    });
  }, [datePreset, customStartDate, customEndDate, nowMs]);

  const sourceFilters = useMemo<DiscoverySourceFilters>(
    () => ({
      firstImportedBy: firstImportedBy || null,
      listedBy: listedBy || null,
    }),
    [firstImportedBy, listedBy]
  );

  const recentById = useMemo(() => {
    const result = new Map<number, RecentAddition>();
    if (!recentIndexMatchesDataset) return result;
    for (const entry of recentAdditions?.events ?? []) {
      result.set(entry.eventId, entry);
    }
    return result;
  }, [recentAdditions, recentIndexMatchesDataset]);

  // Load only month chunks named by matching index rows. This keeps a newly
  // added December event discoverable without opening every event month.
  useEffect(() => {
    if (!manifest?.chunks?.events || !dateWindow) return;
    if (
      recentIndexInfo &&
      (recentIndexState !== "success" || !recentIndexMatchesDataset)
    )
      return;

    const chunkIds = new Set<string>();
    if (recentIndexInfo) {
      for (const entry of recentAdditions?.events ?? []) {
        if (
          isAddedInWindow(entry, dateWindow) &&
          matchesSourceFilters(null, sourceFilters, entry)
        ) {
          chunkIds.add(entry.chunkId);
        }
      }
    } else {
      for (const chunk of manifest.chunks.events) chunkIds.add(chunk.chunkId);
    }

    const datasetKey = manifest.datasetVersion;
    if (chunkRequestDatasetRef.current !== datasetKey) {
      chunkRequestDatasetRef.current = datasetKey;
      requestedChunkIdsRef.current = new Set();
      setPendingChunkIds(new Set());
      setChunkLoadError(null);
    }

    const chunksToLoad = [...chunkIds].filter(
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
  }, [
    dateWindow,
    loadChunk,
    loadedChunks,
    manifest,
    recentAdditions,
    recentIndexMatchesDataset,
    recentIndexInfo,
    recentIndexState,
    sourceFilters,
  ]);

  const justAdded = useMemo(() => {
    if (!dateWindow) return [];

    const rows = Array.from(events.values()).flatMap((event) => {
      const recent = recentById.get(Number(event.id));
      const discoveryData = eventDiscoveryData(event, recent);
      if (!isAddedInWindow(discoveryData, dateWindow)) return [];
      if (!matchesSourceFilters(discoveryData, sourceFilters, recent))
        return [];
      if (!isEventUpcoming(discoveryData, nowMs, DISCOVERY_TIME_ZONE))
        return [];
      return [{ event, discoveryData, recent }];
    });

    return sortNewestAddedFirst(
      rows.map((row) => ({ ...row, ...row.discoveryData }))
    ).map((row) => row.event);
  }, [dateWindow, events, nowMs, recentById, sourceFilters]);

  useEffect(() => {
    setDisplayLimit(100);
  }, [datePreset, customStartDate, customEndDate, firstImportedBy, listedBy]);

  useEffect(() => {
    const element = loadMoreRef.current;
    if (!element || justAdded.length <= displayLimit) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting)
          setDisplayLimit((previous) => previous + 100);
      },
      { threshold: 0.1 }
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [displayLimit, justAdded.length]);

  const isCoreLoading =
    !manifest ||
    loading.manifest === "loading" ||
    loading.artists === "loading" ||
    loading.venues === "loading";
  const isIndexLoading =
    Boolean(recentIndexInfo) && recentIndexState === "loading";
  const isEventsLoading =
    loading.events === "loading" || pendingChunkIds.size > 0;
  const pageError =
    errors.manifest ||
    errors.artists ||
    errors.venues ||
    errors.events ||
    recentIndexError ||
    chunkLoadError;
  const isLoading = isCoreLoading || isIndexLoading || isEventsLoading;

  const windowLabel = dateWindow
    ? dateWindow.startDate === dateWindow.endDate
      ? formatLocalDate(dateWindow.startEpochMs, {
          month: "long",
          day: "numeric",
          year: "numeric",
        })
      : `${formatLocalDate(dateWindow.startEpochMs, {
          month: "short",
          day: "numeric",
        })}–${formatLocalDate(dateWindow.endEpochMs - 1, {
          month: "short",
          day: "numeric",
          year: "numeric",
        })}`
    : null;

  return (
    <ContentArea
      title="Just Added"
      subtitle={`${justAdded.length} upcoming event${justAdded.length === 1 ? "" : "s"}${windowLabel ? ` · added ${windowLabel}` : ""}`}
    >
      <div className="mb-5 space-y-3" aria-label="Just Added filters">
        <div className="flex flex-wrap items-center gap-1.5">
          {(["today", "last7days", "custom"] as const).map((preset) => (
            <button
              key={preset}
              type="button"
              aria-pressed={datePreset === preset}
              onClick={() => setDatePreset(preset)}
              className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                datePreset === preset
                  ? "bg-purple-600 text-white"
                  : "bg-gray-100 text-gray-600 hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600"
              }`}
            >
              {preset === "today"
                ? "Today"
                : preset === "last7days"
                  ? "Last 7 Days"
                  : "Custom"}
            </button>
          ))}
        </div>

        {datePreset === "custom" && (
          <div className="flex flex-wrap items-end gap-3 text-xs text-gray-600 dark:text-gray-300">
            <label className="flex flex-col gap-1">
              From
              <input
                type="date"
                value={customStartDate}
                onChange={(event) => setCustomStartDate(event.target.value)}
                onInput={(event) =>
                  setCustomStartDate(event.currentTarget.value)
                }
                className="rounded border border-gray-300 bg-white px-2 py-1.5 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-800 dark:text-white"
              />
            </label>
            <label className="flex flex-col gap-1">
              Through
              <input
                type="date"
                value={customEndDate}
                onChange={(event) => setCustomEndDate(event.target.value)}
                onInput={(event) => setCustomEndDate(event.currentTarget.value)}
                className="rounded border border-gray-300 bg-white px-2 py-1.5 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-800 dark:text-white"
              />
            </label>
            {!dateWindow && (
              <span className="pb-1 text-amber-600 dark:text-amber-400">
                Choose a valid inclusive date range.
              </span>
            )}
          </div>
        )}

        <div className="flex flex-wrap items-end gap-3 text-xs text-gray-600 dark:text-gray-300">
          <label className="flex flex-col gap-1">
            First imported by
            <select
              aria-label="First imported by"
              value={firstImportedBy}
              onChange={(event) => setFirstImportedBy(event.target.value)}
              className="rounded border border-gray-300 bg-white px-2 py-1.5 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-800 dark:text-white"
            >
              <option value="">Everyone</option>
              <option value="steveslist">Steve&apos;s List</option>
              <option value="zivv-venue-import">Zivv venue import</option>
            </select>
          </label>
          <label className="flex flex-col gap-1">
            Listed by
            <select
              aria-label="Listed by"
              value={listedBy}
              onChange={(event) => setListedBy(event.target.value)}
              className="rounded border border-gray-300 bg-white px-2 py-1.5 text-sm text-gray-900 dark:border-gray-600 dark:text-white dark:bg-gray-800"
            >
              <option value="">Any source</option>
              <option value="steveslist">Steve&apos;s List</option>
              <option value="venue-calendar">Venue calendar</option>
            </select>
          </label>
        </div>
      </div>

      {pageError && (
        <div
          role="alert"
          className="mb-5 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-200"
        >
          <div className="font-semibold">Unable to load Just Added</div>
          <div>{pageError}</div>
        </div>
      )}

      {isLoading && !pageError && (
        <div className="py-12 text-center">
          <div className="mx-auto mb-4 h-8 w-8 animate-spin rounded-full border-b-2 border-purple-600" />
          <p className="text-sm text-gray-500 dark:text-gray-400">
            Loading recent additions…
          </p>
        </div>
      )}

      {!isLoading && !pageError && !dateWindow && (
        <div className="py-12 text-center text-gray-500 dark:text-gray-400">
          Choose a valid date range to find additions.
        </div>
      )}

      {!isLoading && !pageError && dateWindow && justAdded.length === 0 && (
        <div className="py-12 text-center text-gray-500 dark:text-gray-400">
          No upcoming events were added in this window.
        </div>
      )}

      {!pageError && justAdded.length > 0 && (
        <div className="space-y-0">
          {justAdded.slice(0, displayLimit).map((event) => {
            const headliner = event.headlinerArtistId
              ? artists.get(event.headlinerArtistId)
              : null;
            const venue = event.venueId ? venues.get(event.venueId) : null;
            const recent = recentById.get(Number(event.id));
            const discoveryData = eventDiscoveryData(event, recent);
            const addedLabel = formatAddedDateLabel(
              discoveryData.createdAtEpochMs
            );
            const sources = listSourceKinds(discoveryData, recent);

            return (
              <Link
                key={event.id}
                to={`/events/${event.slug}`}
                className="block rounded px-2 py-2 transition-colors hover:bg-gray-50 dark:hover:bg-gray-700"
              >
                <div className="flex min-w-0 items-baseline gap-2">
                  <span className="w-14 shrink-0 text-xs tabular-nums text-gray-400 dark:text-gray-500">
                    {formatLocalDate(event.dateEpochMs, {
                      month: "short",
                      day: "numeric",
                    }) ?? "Date TBA"}
                  </span>
                  <span className="min-w-0 truncate text-sm font-medium text-gray-900 dark:text-gray-100">
                    {headliner?.name ?? "Show"}
                    {event.artistIds.length > 1 && (
                      <span className="text-xs font-normal text-gray-400 dark:text-gray-500">
                        +{event.artistIds.length - 1}
                      </span>
                    )}
                  </span>
                  {addedLabel && (
                    <span className="shrink-0 text-xs font-semibold text-purple-700 dark:text-purple-300">
                      {addedLabel}
                    </span>
                  )}
                </div>
                <div className="flex min-w-0 items-baseline gap-2">
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
                  <span className="min-w-0 truncate text-xs text-gray-500 dark:text-gray-400">
                    {venue?.name ?? ""}
                  </span>
                </div>
                <div className="ml-16 mt-1 flex flex-wrap gap-x-2 gap-y-1 text-[11px] text-gray-400 dark:text-gray-500">
                  {discoveryData.firstImportedBy && (
                    <span>
                      First imported by{" "}
                      {sourceLabel(discoveryData.firstImportedBy)}
                    </span>
                  )}
                  {sources.length > 0 && (
                    <span>Listed by {sources.map(sourceLabel).join(", ")}</span>
                  )}
                </div>
              </Link>
            );
          })}
          {justAdded.length > displayLimit && (
            <div ref={loadMoreRef} className="py-6 text-center">
              <div className="mx-auto h-5 w-5 animate-spin rounded-full border-b-2 border-gray-500" />
            </div>
          )}
        </div>
      )}
    </ContentArea>
  );
};

export default NewEventsPage;
