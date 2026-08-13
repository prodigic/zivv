import type { Event, EventChunk } from "@/types/events.js";
import type { DataManifest, FileInfo } from "@/types/data.js";
import type { CanonicalModel, TemporalProjectionModel } from "@/lib/etl/pipeline/types.js";

export const DUCKDB_SCHEMA_VERSION = "1";
export const DUCKDB_BACKEND_NAME = "duckdb-node-api";
export const MEMORY_BACKEND_NAME = "deterministic-memory";

export interface SnapshotDescriptor {
  readonly snapshotId: string;
  readonly sequence: number;
  readonly sourceDate: string;
  readonly sourceChecksum: string;
  readonly processedAtEpochMs: number;
  readonly asOfEpochMs: number;
  readonly schemaVersion: string;
  readonly datasetVersion: string;
}

export interface StagedSnapshot {
  readonly descriptor: SnapshotDescriptor;
  readonly model: CanonicalModel;
  readonly projections: TemporalProjectionModel;
}

export interface CanonicalEventRow extends Event {
  readonly stableKey: string;
}

export type CanonicalArtistRow = CanonicalModel["artists"][number] & { readonly stableKey: string };

export type CanonicalVenueRow = CanonicalModel["venues"][number] & { readonly stableKey: string };

export interface EventArtistRow {
  readonly eventStableKey: string;
  readonly artistStableKey: string;
  readonly billingOrder: number;
  readonly isHeadliner: boolean;
}

export interface EventTagRow {
  readonly eventStableKey: string;
  readonly tag: string;
}

export interface EventProjectionRow {
  readonly eventStableKey: string;
  readonly chunkId: string;
  readonly asOfEpochMs: number;
  readonly isUpcoming: boolean;
}

export interface DirectoryProjectionRow {
  readonly entityStableKey: string;
  readonly entityType: "artist" | "venue";
  readonly upcomingEventCount: number;
  readonly asOfEpochMs: number;
}

export interface SearchProjectionRow {
  readonly documentKey: string;
  readonly entityStableKey: string;
  readonly entityType: "event" | "artist" | "venue";
  readonly title: string;
  readonly content: string;
}

export interface CanonicalState {
  readonly snapshots: readonly SnapshotDescriptor[];
  readonly events: readonly CanonicalEventRow[];
  readonly artists: readonly CanonicalArtistRow[];
  readonly venues: readonly CanonicalVenueRow[];
  readonly eventArtists: readonly EventArtistRow[];
  readonly eventTags: readonly EventTagRow[];
  readonly eventProjections: readonly EventProjectionRow[];
  readonly directoryProjections: readonly DirectoryProjectionRow[];
  readonly searchProjections: readonly SearchProjectionRow[];
}

export interface ExportArtifact {
  readonly filename: string;
  readonly bytes: Uint8Array;
  readonly text: string;
  readonly metadata: FileInfo;
}

export interface StaticExport {
  readonly manifest: DataManifest;
  readonly artifacts: readonly ExportArtifact[];
  readonly chunks: readonly EventChunk[];
}

export interface BuildStore {
  readonly backend: string;
  initialize(): Promise<void>;
  applySnapshot(snapshot: StagedSnapshot): Promise<{ readonly inserted: number; readonly updated: number; readonly replayed: boolean }>;
  readState(): Promise<CanonicalState>;
  close(): Promise<void>;
}

export interface DuckDbRuntimeStatus {
  readonly packageName: typeof DUCKDB_BACKEND_NAME;
  readonly available: boolean;
  readonly reason: string;
}
