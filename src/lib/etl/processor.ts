import {
  existsSync,
  mkdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type {
  Event,
  Artist,
  Venue,
  EventProvenance,
} from "../../types/events.js";
import type {
  DataManifest,
  FileInfo,
  ProcessingResult,
  RecentAdditionsIndex,
  SourceFileInfo,
} from "../../types/data.js";
import { loadLedger } from "../ingestion/ledger.js";
import { ledgerDigest } from "../ingestion/sqlite-store.js";
import {
  captureExportConfiguration,
  configurationDigest,
  type CandidateConfiguration,
} from "../ingestion/export-configuration.js";
import { buildCapturedEventSlugRedirects } from "../ingestion/event-slug-redirects.js";
import {
  capturedExportCatalog,
  configurationJson,
} from "../ingestion/export-catalog.js";
import { namesForVerificationStatus } from "../ingestion/local-artist-verification.js";
import type { LocalArtistVerificationLedger } from "../ingestion/local-artist-verification.js";
import { withIngestionLock } from "../ingestion/lock.js";
import { isEventUpcoming, localDateKey } from "../discovery.js";
import { DataIndexer, DataChunker, SearchIndexBuilder } from "./indexer.js";

/** Export the durable ledger. Rebuilding is deliberately not an import. */
export class ETLProcessor {
  private readonly projectRoot: string;
  constructor(projectRoot: string) {
    this.projectRoot = resolve(projectRoot);
  }

  async processData(): Promise<ProcessingResult> {
    return withIngestionLock(this.projectRoot, () => this.exportData());
  }

  private async exportData(): Promise<ProcessingResult> {
    const start = Date.now();
    try {
      const configuration = captureExportConfiguration(this.projectRoot);
      const sourceConfigurationSha256 = configurationDigest(configuration);
      const ledger = await loadLedger(
        join(this.projectRoot, "data/ingestion/ledger.json")
      );
      const {
        events,
        artists,
        venues,
        posters,
        staleReviews,
        staleArtistLinks,
      } = capturedExportCatalog(ledger, configuration);
      this.validateReferences(events, artists, venues);
      ETLProcessor.populateExportSummaries(events, artists, venues, start);
      const indexes = DataIndexer.buildIndexes(events, artists, venues, start);
      indexes.eventSlugRedirects = buildCapturedEventSlugRedirects(
        configurationJson(configuration, "event-slug-redirects.json") ?? [],
        events
      );
      const { chunks, chunkInfos } = DataChunker.chunkEventsByMonth(events);
      const { documents, terms } = SearchIndexBuilder.buildSearchIndex(
        events,
        artists,
        venues
      );
      const datasetVersion = new Date(start).toISOString();
      const stage = join(
        this.projectRoot,
        ".cache",
        `etl-export-${randomUUID()}`
      );
      mkdirSync(stage, { recursive: true });
      const write = (filename: string, data: unknown): FileInfo => {
        const bytes = Buffer.from(JSON.stringify(data, null, 2) + "\n", "utf8");
        writeFileSync(join(stage, filename), bytes);
        return {
          filename,
          size: bytes.length,
          checksum: this.checksum(bytes),
          ...(Array.isArray(data) ? { recordCount: data.length } : {}),
        };
      };
      chunks.forEach((chunk, i) =>
        Object.assign(
          chunkInfos[i],
          write(`events-${chunk.chunkId}.json`, chunk)
        )
      );
      const artistFile = write("artists.json", artists);
      const venueFile = write("venues.json", venues);
      const indexFile = write("indexes.json", indexes);
      write("search-documents.json", documents);
      write("search-terms.json", terms);
      // Full-ledger compact index supports custom ranges and missed weekly runs.
      const additions: RecentAdditionsIndex = {
        schemaVersion: 1,
        datasetVersion,
        events: ledger.events.map((e) => ({
          eventId: e.id,
          chunkId: e.date.slice(0, 7),
          createdAtEpochMs: e.createdAtEpochMs,
          addedDateProvenance: e.addedDateProvenance,
          firstImportedBy: e.firstImportedBy,
          sourceKinds: [...new Set(e.sources.map((s) => s.kind))],
        })),
      };
      const additionsFile = write("recent-additions.json", additions);
      const dates = events.map((e) => e.dateEpochMs).sort((a, b) => a - b);
      const first = dates[0] ?? start;
      const last = dates.at(-1) ?? start;
      const manifest: DataManifest = {
        version: "2.0.0",
        schemaVersion: "2.0.0",
        datasetVersion,
        lastUpdated: start,
        sourceLedgerRevision: ledgerDigest(ledger),
        sourceConfigurationSha256,
        processedAt: start,
        latestIngestionDate:
          localDateKey(
            Math.max(0, ...ledger.events.map((e) => e.createdAtEpochMs || 0)),
            "America/Los_Angeles"
          ) ?? new Date(start).toISOString().slice(0, 10),
        totalEvents: events.length,
        totalArtists: artists.length,
        totalVenues: venues.length,
        dateRange: {
          startEpochMs: first,
          endEpochMs: last,
          startDate: new Date(first).toISOString().slice(0, 10),
          endDate: new Date(last).toISOString().slice(0, 10),
        },
        chunks: {
          events: chunkInfos,
          artists: artistFile,
          venues: venueFile,
          indexes: indexFile,
          recentAdditions: additionsFile,
        },
        sourceFiles: {
          events: this.sourceInfo("events.txt", configuration),
          venues: this.sourceInfo("venues.txt", configuration),
          venueSources: this.sourceInfo("venue-sources.json", configuration),
          ...(configuration["artist-links.json"] !== null
            ? {
                artistLinks: this.sourceInfo(
                  "artist-links.json",
                  configuration
                ),
              }
            : {}),
          ...(configuration["artist-reviews.json"] !== null
            ? {
                artistReviews: this.sourceInfo(
                  "artist-reviews.json",
                  configuration
                ),
              }
            : {}),
          ...(configuration["event-posters.json"] !== null
            ? {
                eventPosters: this.sourceInfo(
                  "event-posters.json",
                  configuration
                ),
              }
            : {}),
        },
      };
      if (configuration["ingestion/weekly-editions.json"] !== null) {
        const { parseWeeklyEditionLedger } =
          await import("../ingestion/weekly.js");
        const weekly = parseWeeklyEditionLedger(
          configurationJson(configuration, "ingestion/weekly-editions.json")
        );
        const edition = [...weekly.editions].sort(
          (a, b) => b.endEpochMs - a.endEpochMs
        )[0];
        if (edition)
          manifest.weeklyEdition = {
            editionId: edition.editionId,
            startEpochMs: edition.startEpochMs,
            endEpochMs: edition.endEpochMs,
            eventIds: edition.eventIds.map(Number),
            datasetVersion: edition.datasetVersion,
          };
      }
      const verification: LocalArtistVerificationLedger =
        configuration["local-artist-verification.json"] !== null
          ? (configurationJson(
              configuration,
              "local-artist-verification.json"
            ) as LocalArtistVerificationLedger)
          : { schemaVersion: 1, entries: [] };
      write(
        "local-artists.json",
        namesForVerificationStatus(verification, "local", artists)
      );
      write(
        "local-artist-exclude.json",
        namesForVerificationStatus(verification, "non-local", artists)
      );
      if (
        configurationDigest(captureExportConfiguration(this.projectRoot)) !==
        sourceConfigurationSha256
      )
        throw new Error("ETL configuration changed during export");
      write("manifest.json", manifest);
      // Paths are fixed children of the resolved project root. Preserve the old
      // directory as rollback; failed replacement restores it immediately.
      const output = join(this.projectRoot, "public/data");
      const backup = join(
        this.projectRoot,
        ".cache",
        `etl-backup-${randomUUID()}`
      );
      mkdirSync(join(this.projectRoot, "public"), { recursive: true });
      const hadOutput = existsSync(output);
      if (hadOutput) renameSync(output, backup);
      try {
        renameSync(stage, output);
      } catch (error) {
        if (hadOutput) renameSync(backup, output);
        throw error;
      }
      return {
        success: true,
        manifest,
        errors: [],
        warnings: [
          ...staleArtistLinks.map((artistId) => ({
            type: "data-quality" as const,
            message: `Links skipped because artist identity changed: ${artistId}`,
          })),
          ...posters.stale.map((eventId) => ({
            type: "data-quality" as const,
            message: `Poster skipped because show identity changed: ${eventId}`,
          })),
          ...staleReviews.map((artistId) => ({
            type: "data-quality" as const,
            message: `Review skipped because artist identity changed: ${artistId}`,
          })),
        ],
        stats: {
          sourceEvents: events.length,
          sourceVenues: venues.length,
          parsedEvents: events.length,
          parsedVenues: venues.length,
          parsedArtists: artists.length,
          duplicateEventsRemoved: 0,
          duplicateArtistsRemoved: 0,
          duplicateVenuesRemoved: 0,
          validationErrors: 0,
          validationWarnings: 0,
          processingTimeMs: Date.now() - start,
          chunks: {
            total: chunks.length,
            averageSize: chunks.length ? events.length / chunks.length : 0,
            largestSize: Math.max(0, ...chunks.map((c) => c.events.length)),
          },
        },
      };
    } catch (error) {
      return {
        success: false,
        manifest: {} as DataManifest,
        stats: {} as ProcessingResult["stats"],
        errors: [
          {
            type: "critical",
            message: `ETL export failed: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
        warnings: [],
      };
    }
  }

  private checksum(bytes: string | Buffer): string {
    return `sha256-${createHash("sha256").update(bytes).digest("hex")}`;
  }

  private sourceInfo(
    filename: keyof CandidateConfiguration,
    configuration: CandidateConfiguration
  ): SourceFileInfo {
    const file = join(this.projectRoot, "data", filename);
    const bytes = configuration[filename] ?? Buffer.from("");
    return {
      filename,
      size: bytes.length,
      checksum: this.checksum(bytes),
      lineCount: bytes.toString("utf8").split(/\r?\n/).length,
      lastModified: existsSync(file) ? statSync(file).mtimeMs : 0,
    };
  }

  private validateReferences(
    events: Event[],
    artists: Artist[],
    venues: Venue[]
  ): void {
    const artistIds = new Set(artists.map((a) => a.id));
    const venueIds = new Set(venues.map((v) => v.id));
    if (new Set(events.map((e) => e.id)).size !== events.length)
      throw new Error("Duplicate canonical event IDs");
    for (const e of events) {
      if (
        !venueIds.has(e.venueId) ||
        !artistIds.has(e.headlinerArtistId) ||
        e.artistIds.some((id) => !artistIds.has(id))
      )
        throw new Error(`Broken entity reference on event ${e.id}`);
      if (!e.firstImportedBy || !e.sources?.length || !e.addedDateProvenance)
        throw new Error(`Missing provenance on event ${e.id}`);
    }
  }

  static populateExportSummaries(
    events: Event[],
    artists: Artist[],
    venues: Venue[],
    now: number
  ): void {
    const artistMap = new Map(artists.map((a) => [a.id, a]));
    const venueMap = new Map(venues.map((v) => [v.id, v]));
    for (const entity of [...artists, ...venues]) {
      entity.totalEventCount = 0;
      entity.upcomingEventCount = 0;
      entity.upcomingEvents = [];
    }
    for (const e of events) {
      const venue = venueMap.get(e.venueId)!;
      const headliner = artistMap.get(e.headlinerArtistId)!;
      venue.totalEventCount++;
      e.artistIds.forEach((id) => artistMap.get(id)!.totalEventCount++);
      if (!isEventUpcoming(e, now)) continue;
      const provenance: EventProvenance = {
        firstImportedBy: e.firstImportedBy,
        addedDateProvenance: e.addedDateProvenance,
        sources: e.sources,
        timeBasis: e.timeBasis,
      };
      const summary = {
        id: e.id,
        slug: e.slug,
        dateEpochMs: e.dateEpochMs,
        startTimeEpochMs: e.startTimeEpochMs,
        headlinerName: headliner.name,
        isFree: e.isFree,
        isSoldOut: e.status === "sold-out" || e.tags.includes("sold-out"),
        priceMin: e.priceMin,
        priceMax: e.priceMax,
        createdAtEpochMs: e.createdAtEpochMs,
        ...(e.poster ? { poster: e.poster } : {}),
        ...provenance,
      };
      venue.upcomingEventCount++;
      venue.upcomingEvents.push(summary);
      for (const id of e.artistIds) {
        const artist = artistMap.get(id)!;
        artist.upcomingEventCount++;
        artist.upcomingEvents.push({
          ...summary,
          venueId: venue.id,
          venueName: venue.name,
          venueCity: venue.city,
        });
      }
    }
    for (const entity of [...artists, ...venues])
      entity.upcomingEvents.sort((a, b) => a.dateEpochMs - b.dateEpochMs);
  }
}
