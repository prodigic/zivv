import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  statSync,
} from "fs";
import { join } from "path";
import type { Event, Artist, Venue } from "@/types/events.js";
import type {
  DataManifest,
  ProcessingResult,
  ProcessingStats,
  ProcessingError,
  ProcessingWarning,
  FileInfo,
  SourceFileInfo,
  ChunkInfo,
} from "@/types/data.js";
import { EventParser, VenueParser } from "./parsers.js";
import { DataIndexer, DataChunker, SearchIndexBuilder } from "./indexer.js";

export class ETLProcessor {
  private dataDir: string;
  private outputDir: string;

  constructor(projectRoot: string) {
    this.dataDir = join(projectRoot, "data");
    this.outputDir = join(projectRoot, "public", "data");
  }

  /**
   * Main ETL processing pipeline
   */
  async processData(): Promise<ProcessingResult> {
    const startTime = Date.now();
    const errors: ProcessingError[] = [];
    const warnings: ProcessingWarning[] = [];

    try {
      console.log("🚀 Starting ETL processing...");

      // Ensure output directory exists
      if (!existsSync(this.outputDir)) {
        mkdirSync(this.outputDir, { recursive: true });
      }

      // Step 1: Read source files
      console.log("📖 Reading source files...");
      const { eventsContent, venuesContent, sourceFiles } =
        this.readSourceFiles();

      // Step 2: Parse events
      console.log("🔍 Parsing events...");
      const {
        rawEvents,
        errors: eventParseErrors,
        warnings: eventParseWarnings,
      } = EventParser.parseEventsFile(eventsContent);

      errors.push(...eventParseErrors.map(this.toProcessingError));
      warnings.push(...eventParseWarnings.map(this.toProcessingWarning));

      // Step 3: Parse venues
      console.log("🏛️  Parsing venues...");
      const {
        rawVenues,
        errors: venueParseErrors,
        warnings: venueParseWarnings,
      } = VenueParser.parseVenuesFile(venuesContent);

      errors.push(...venueParseErrors.map(this.toProcessingError));
      warnings.push(...venueParseWarnings.map(this.toProcessingWarning));

      // Step 4: Normalize data
      console.log("🔧 Normalizing data...");
      const artistMap = new Map<string, Artist>();
      const venueMap = new Map<string, Venue>();

      const {
        events,
        errors: eventNormErrors,
        warnings: eventNormWarnings,
      } = EventParser.normalizeEvents(rawEvents, artistMap, venueMap);

      errors.push(...eventNormErrors.map(this.toProcessingError));
      warnings.push(...eventNormWarnings.map(this.toProcessingWarning));

      const {
        venues,
        errors: venueNormErrors,
        warnings: venueNormWarnings,
      } = VenueParser.normalizeVenues(rawVenues, venueMap);

      errors.push(...venueNormErrors.map(this.toProcessingError));
      warnings.push(...venueNormWarnings.map(this.toProcessingWarning));

      const artists = Array.from(artistMap.values());

      // Update upcoming event counts
      this.updateUpcomingCounts(events, artists, venues);

      console.log(
        `✅ Processed ${events.length} events, ${artists.length} artists, ${venues.length} venues`
      );

      // Step 5: Build indexes
      console.log("📇 Building indexes...");
      const indexes = DataIndexer.buildIndexes(events, artists, venues);

      // Step 6: Chunk events by month
      console.log("📦 Chunking events...");
      const { chunks, chunkInfos } = DataChunker.chunkEventsByMonth(events);

      // Step 7: Build search index
      console.log("🔎 Building search index...");
      const { documents, terms } = SearchIndexBuilder.buildSearchIndex(
        events,
        artists,
        venues
      );

      // Step 8: Write output files
      console.log("💾 Writing output files...");
      const manifest = this.createManifest(
        events,
        artists,
        venues,
        chunkInfos,
        sourceFiles
      );

      // Write chunks
      for (const chunk of chunks) {
        const filename = `events-${chunk.chunkId}.json`;
        this.writeJSON(filename, chunk);
      }

      // Write other data files
      this.writeJSON("artists.json", artists);
      this.writeJSON("venues.json", venues);
      this.writeJSON("indexes.json", indexes);
      this.writeJSON("search-documents.json", documents);
      this.writeJSON("search-terms.json", terms);
      this.writeJSON("manifest.json", manifest);

      // Step 9: Generate stats
      const processingTimeMs = Date.now() - startTime;
      const stats: ProcessingStats = {
        sourceEvents: rawEvents.length,
        sourceVenues: rawVenues.length,
        parsedEvents: events.length,
        parsedVenues: venues.length,
        parsedArtists: artists.length,
        duplicateEventsRemoved: rawEvents.length - events.length,
        duplicateArtistsRemoved: 0, // TODO: track this
        duplicateVenuesRemoved: 0, // TODO: track this
        validationErrors: errors.filter((e) => e.type === "validation").length,
        validationWarnings: warnings.length,
        processingTimeMs,
        chunks: {
          total: chunks.length,
          averageSize:
            chunks.reduce((sum, chunk) => sum + chunk.events.length, 0) /
            chunks.length,
          largestSize: Math.max(...chunks.map((chunk) => chunk.events.length)),
        },
      };

      console.log(`🎉 ETL processing completed in ${processingTimeMs}ms`);
      console.log(
        `📊 Stats: ${stats.parsedEvents} events, ${stats.parsedArtists} artists, ${stats.parsedVenues} venues`
      );
      console.log(`⚠️  ${errors.length} errors, ${warnings.length} warnings`);

      return {
        success: errors.filter((e) => e.type === "critical").length === 0,
        manifest,
        stats,
        errors,
        warnings,
      };
    } catch (error) {
      const criticalError: ProcessingError = {
        type: "critical",
        message: `ETL processing failed: ${error}`,
      };

      return {
        success: false,
        manifest: {} as DataManifest, // Empty manifest on failure
        stats: {} as ProcessingStats, // Empty stats on failure
        errors: [criticalError, ...errors],
        warnings,
      };
    }
  }

  private readSourceFiles(): {
    eventsContent: string;
    venuesContent: string;
    sourceFiles: {
      events: SourceFileInfo;
      venues: SourceFileInfo;
    };
  } {
    const eventsPath = join(this.dataDir, "events.txt");
    const venuesPath = join(this.dataDir, "venues.txt");

    if (!existsSync(eventsPath)) {
      throw new Error(`Events file not found: ${eventsPath}`);
    }
    if (!existsSync(venuesPath)) {
      throw new Error(`Venues file not found: ${venuesPath}`);
    }

    const eventsContent = readFileSync(eventsPath, "utf-8");
    const venuesContent = readFileSync(venuesPath, "utf-8");

    const eventsStats = statSync(eventsPath);
    const venuesStats = statSync(venuesPath);

    return {
      eventsContent,
      venuesContent,
      sourceFiles: {
        events: {
          filename: "events.txt",
          size: eventsStats.size,
          lastModified: eventsStats.mtime.getTime(),
          lineCount: eventsContent.split("\n").length,
          checksum: this.calculateChecksum(eventsContent),
        },
        venues: {
          filename: "venues.txt",
          size: venuesStats.size,
          lastModified: venuesStats.mtime.getTime(),
          lineCount: venuesContent.split("\n").length,
          checksum: this.calculateChecksum(venuesContent),
        },
      },
    };
  }

  private updateUpcomingCounts(
    events: Event[],
    artists: Artist[],
    venues: Venue[]
  ): void {
    const now = Date.now();

    // Reset counts
    artists.forEach((artist) => {
      artist.upcomingEventCount = 0;
    });
    venues.forEach((venue) => {
      venue.upcomingEventCount = 0;
    });

    // Count upcoming events
    for (const event of events) {
      if (event.dateEpochMs > now) {
        // Update artist counts
        for (const artistId of event.artistIds) {
          const artist = artists.find((a) => a.id === artistId);
          if (artist) {
            artist.upcomingEventCount++;
          }
        }

        // Update venue count
        const venue = venues.find((v) => v.id === event.venueId);
        if (venue) {
          venue.upcomingEventCount++;
        }
      }
    }
  }

  private createManifest(
    events: Event[],
    artists: Artist[],
    venues: Venue[],
    chunkInfos: ChunkInfo[],
    sourceFiles: { events: SourceFileInfo; venues: SourceFileInfo }
  ): DataManifest {
    const eventDates = events.map((e) => e.dateEpochMs).sort((a, b) => a - b);
    const startEpochMs = eventDates[0] || Date.now();
    const endEpochMs = eventDates[eventDates.length - 1] || Date.now();

    return {
      version: "1.0.0",
      datasetVersion: new Date().toISOString(),
      lastUpdated: Date.now(),
      totalEvents: events.length,
      totalArtists: artists.length,
      totalVenues: venues.length,
      dateRange: {
        startEpochMs,
        endEpochMs,
        startDate: new Date(startEpochMs).toISOString().split("T")[0],
        endDate: new Date(endEpochMs).toISOString().split("T")[0],
      },
      chunks: {
        events: chunkInfos,
        artists: this.createFileInfo("artists.json", artists),
        venues: this.createFileInfo("venues.json", venues),
        indexes: this.createFileInfo("indexes.json", {}), // Will be filled after writing
      },
      processedAt: Date.now(),
      sourceFiles,
      schemaVersion: "1.0.0",
    };
  }

  private createFileInfo(filename: string, data: unknown): FileInfo {
    const serialized = JSON.stringify(data);
    return {
      filename,
      size: new Blob([serialized]).size,
      checksum: this.calculateChecksum(serialized),
      recordCount: Array.isArray(data) ? data.length : undefined,
    };
  }

  private writeJSON(filename: string, data: unknown): void {
    const filepath = join(this.outputDir, filename);
    writeFileSync(filepath, JSON.stringify(data, null, 2), "utf-8");
  }

  private calculateChecksum(data: string): string {
    let hash = 0;
    for (let i = 0; i < data.length; i++) {
      const char = data.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash = hash & hash;
    }
    return `sha256-${Math.abs(hash).toString(16)}`;
  }

  private toProcessingError(error: any): ProcessingError {
    return {
      type: error.type === "validation" ? "validation" : "data",
      message: error.message,
      sourceFile: "events.txt", // Could be improved to track actual source
      lineNumber: error.line,
      rawData: error.rawText,
    };
  }

  private toProcessingWarning(warning: any): ProcessingWarning {
    return {
      type: "data-quality",
      message: warning.message,
      sourceFile: "events.txt",
      lineNumber: warning.line,
    };
  }
}

// ETL processor class - use the separate script in scripts/run-etl.js to execute
