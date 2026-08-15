import type {
  Artist,
  Event,
  Venue,
  ArtistUpcomingEvent,
  VenueUpcomingEvent,
} from "@/types/events.js";
import type { ProcessingError, ProcessingWarning, SourceFileInfo } from "@/types/data.js";

export interface ETLInputConfig {
  /** Directory containing the configured source files. */
  inputDir?: string;
  /** Events source filename, relative to inputDir unless eventsPath is set. */
  eventsFile?: string;
  /** Venue source filename, relative to inputDir unless venuesPath is set. */
  venuesFile?: string;
  eventsPath?: string;
  venuesPath?: string;
  aliasesPath?: string;
}

export interface ETLOutputConfig {
  /** Directory receiving generated files. Defaults to public/data. */
  outputDir?: string;
  /** Keep the pipeline pure when false; defaults to true for the legacy processor. */
  write?: boolean;
}

export interface ETLRunConfig extends ETLInputConfig, ETLOutputConfig {
  /** Fixed time makes repeat processing deterministic in tests and snapshot builds. */
  processingTimestamp?: number;
  /** Reference time used only for temporal projections. */
  asOfEpochMs?: number;
}

export interface SourceBundle {
  eventsContent: string;
  venuesContent: string;
  sourceFiles: {
    events: SourceFileInfo;
    venues: SourceFileInfo;
  };
  aliases: Record<string, string>;
}

export interface ProvenanceRecord {
  sourceFile: string;
  sourceLineNumber: number;
  rawText?: string;
  firstSeenEpochMs: number;
  lastSeenEpochMs: number;
}

export type CanonicalArtist = Omit<Artist, "upcomingEventCount" | "upcomingEvents"> & {
  provenance: ProvenanceRecord;
};

export type CanonicalVenue = Omit<Venue, "upcomingEventCount" | "upcomingEvents"> & {
  provenance: ProvenanceRecord;
};

export interface CanonicalModel {
  events: Event[];
  artists: CanonicalArtist[];
  venues: CanonicalVenue[];
  provenance: {
    events: Map<number, ProvenanceRecord>;
    artists: Map<number, ProvenanceRecord>;
    venues: Map<number, ProvenanceRecord>;
  };
}

export interface TemporalProjectionModel {
  asOfEpochMs: number;
  artistUpcomingEventCount: Map<number, number>;
  venueUpcomingEventCount: Map<number, number>;
  artistUpcomingEvents: Map<number, ArtistUpcomingEvent[]>;
  venueUpcomingEvents: Map<number, VenueUpcomingEvent[]>;
}

export interface NormalizationStageResult {
  model: CanonicalModel;
  rawEventCount: number;
  rawVenueCount: number;
  errors: ProcessingError[];
  warnings: ProcessingWarning[];
}
