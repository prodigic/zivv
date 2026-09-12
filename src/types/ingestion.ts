import type { Artist, Event, EventId, Venue, VenueId } from "./events.js";

/** The schema version written by the ingestion ledger. */
export const INGESTION_SCHEMA_VERSION = 1 as const;
export type IngestionSchemaVersion = typeof INGESTION_SCHEMA_VERSION;

/** A source which can contribute a listing to the canonical catalog. */
export type SourceKind = "steveslist" | "venue-calendar";

/** The immutable source which first caused an event to be accepted. */
export type FirstImportedBy = "steveslist" | "zivv-venue-import";

/** Precision of the public date-added value. */
export type AddedDateProvenance = "observed" | "legacy-batch" | "unknown";

export type MigrationBasis = "all-prior-events-steveslist";

/** Values retained in conflict records must be JSON-safe. */
export type ProvenanceValue =
  | string
  | number
  | boolean
  | null
  | ProvenanceValue[]
  | { [key: string]: ProvenanceValue };

/** A stable association between one canonical event and one source listing. */
export interface SourceLink {
  kind: SourceKind;
  sourceId: string;
  externalEventId: string | null;
  canonicalUrl: string | null;
  /** The source's original venue/room ID, before canonical venue mapping. */
  originalVenueId: VenueId | null;
  /** A source-specific room/session label when it is available. */
  session: string | null;
  firstSeenAtEpochMs: number | null;
  lastSeenAtEpochMs: number | null;
  contentHash: string;
  firstSeenRunId: string | null;
  lastSeenRunId: string | null;
  /** A bounded pointer or note into retained source evidence. */
  evidence: string | null;
}

/** A field-level discrepancy retained when two source observations disagree. */
export interface ProvenanceConflict {
  field: string;
  existingValue: ProvenanceValue;
  incomingValue: ProvenanceValue;
  existingSource: string | null;
  incomingSource: string;
  detectedAtEpochMs: number;
  reason:
    | "source-update"
    | "source-linked-reschedule"
    | "venue-authority"
    | "ambiguous-match";
}

/** Fields which are mandatory for every event persisted by the ledger. */
export interface IngestionEventProvenance {
  firstImportedBy: FirstImportedBy;
  addedDateProvenance: AddedDateProvenance;
  firstObservedAtEpochMs: number | null;
  announcedAtEpochMs: number | null;
  firstImportRunId: string | null;
  sources: SourceLink[];
  provenanceConflicts: ProvenanceConflict[];
}

/** Canonical event shape inside the durable ledger. */
export type LedgerEvent = Event & IngestionEventProvenance;

/** Source identity fields carried alongside a transient Event candidate. */
export interface IngestionCandidateMetadata {
  externalEventId?: string | null;
  /** Alias accepted by adapters which use provider terminology. */
  sourceEventId?: string | null;
  canonicalUrl?: string | null;
  /** Capitalized URL alias used by source schemas. */
  canonicalURL?: string | null;
  session?: string | null;
  /** Original source venue/room ID, if it differs from event.venueId. */
  sourceVenueId?: VenueId | null;
  /** Alias used by some provider adapters. */
  originalVenueId?: VenueId | null;
  announcedAtEpochMs?: number | null;
  evidence?: string | null;
  /** A source adapter may supply an exact hash; otherwise it is derived. */
  contentHash?: string;
}

/** A candidate event plus source identity which is not part of Event yet. */
export interface IngestionCandidateEvent extends IngestionCandidateMetadata {
  event: Event;
}

/** Adapters may pass a plain Event when no per-event source key exists. */
export type IngestionEventInput =
  Event | IngestionCandidateEvent | (Event & IngestionCandidateMetadata);

export interface IngestionBatch {
  runId: string;
  origin: FirstImportedBy;
  observedAtEpochMs: number;
  sourceId: string;
  sourceUrl?: string | null;
  /** Optional exact source hash supplied by the adapter. */
  contentHash?: string;
  events: IngestionEventInput[];
  artists: Artist[];
  venues: Venue[];
}

export interface IngestionMigration {
  basis: MigrationBasis;
  migratedAtEpochMs: number;
}

export type IngestionRunStatus =
  "reconciled" | "committed" | "published" | "failed";

export interface IngestionRun {
  runId: string;
  origin: FirstImportedBy;
  sourceId: string;
  sourceUrl: string | null;
  observedAtEpochMs: number;
  contentHash: string;
  status: IngestionRunStatus;
  acceptedEventIds: EventId[];
  newEventIds: EventId[];
  updatedEventIds: EventId[];
  linkedEventIds: EventId[];
  reviewCount: number;
  conflictCount: number;
  reconciledAtEpochMs: number;
  committedAtEpochMs: number | null;
  publishedAtEpochMs: number | null;
}

export interface EventRedirect {
  fromEventId: EventId;
  toEventId: EventId;
  reason: "duplicate-merge" | "manual-merge";
  createdAtEpochMs: number;
}

export interface IngestionLedger {
  schemaVersion: IngestionSchemaVersion;
  /** Monotonic ledger revision, serialized as a string for stable JSON. */
  version: string;
  migration: IngestionMigration;
  /** Convenience copy for consumers which only need the migration basis. */
  migrationBasis: MigrationBasis;
  events: LedgerEvent[];
  artists: Artist[];
  venues: Venue[];
  runs: IngestionRun[];
  redirects: EventRedirect[];
}

export interface IngestionSnapshot {
  events: Event[];
  artists: Artist[];
  venues: Venue[];
}

export interface ReconciliationReview {
  candidateIndex: number;
  candidateEventId: EventId;
  reason:
    | "ambiguous-match"
    | "legacy-time-uncertain"
    | "invalid-candidate"
    | "conflicting-source-identity";
  message: string;
  existingEventIds: EventId[];
}

export interface ReconciliationConflict extends ProvenanceConflict {
  eventId: EventId;
}

export interface ReconciliationReport {
  runId: string;
  replay: boolean;
  historicalBatch?: {
    sourceCommit: string;
    datasetVersion: string;
    processedAtEpochMs: number;
  };
  acceptedEventIds: EventId[];
  newEventIds: EventId[];
  updatedEventIds: EventId[];
  linkedEventIds: EventId[];
  review: ReconciliationReview[];
  conflicts: ReconciliationConflict[];
}

export interface ReconciliationResult {
  ledger: IngestionLedger;
  report: ReconciliationReport;
}

export class IngestionLedgerError extends Error {
  readonly code:
    "invalid-input" | "missing-ledger" | "corrupt-ledger" | "replay-conflict";

  constructor(
    code:
      "invalid-input" | "missing-ledger" | "corrupt-ledger" | "replay-conflict",
    message: string
  ) {
    super(message);
    this.name = "IngestionLedgerError";
    this.code = code;
  }
}
