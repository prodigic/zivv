import { createHash } from "node:crypto";
import type { DataManifest, FileInfo } from "@/types/data.js";
import { buildMonthlyChunks } from "./projections.js";
import { canonicalArtists, canonicalVenues } from "./staging.js";
import type { ExportArtifact, SnapshotDescriptor, StagedSnapshot, StaticExport } from "./types.js";

function stableJson(value: unknown): string {
  return `${JSON.stringify(value, (_key, nested) => {
    if (!nested || typeof nested !== "object" || Array.isArray(nested)) return nested;
    return Object.fromEntries(Object.entries(nested).sort(([left], [right]) => left.localeCompare(right)));
  }, 2)}\n`;
}

function artifact(filename: string, value: unknown): ExportArtifact {
  const text = stableJson(value);
  const bytes = new TextEncoder().encode(text);
  const checksum = `sha256-${createHash("sha256").update(bytes).digest("hex")}`;
  return { filename, bytes, text, metadata: { filename, size: bytes.byteLength, checksum } };
}

function fileInfo(artifactValue: ExportArtifact, recordCount: number): FileInfo {
  return { ...artifactValue.metadata, recordCount };
}

export function exportStaticJson(snapshot: StagedSnapshot): StaticExport {
  const chunks = buildMonthlyChunks(snapshot);
  const events = chunks.map((chunk) => artifact(`events-${chunk.chunkId}.json`, chunk));
  const artists = artifact("artists.json", canonicalArtists(snapshot));
  const venues = artifact("venues.json", canonicalVenues(snapshot));
  const indexes = artifact("indexes.json", { eventsByDate: {}, eventsByArtist: {}, eventsByVenue: {} });
  const artifacts = [...events, artists, venues, indexes];
  const start = Math.min(...snapshot.model.events.map((event) => event.dateEpochMs));
  const end = Math.max(...snapshot.model.events.map((event) => event.dateEpochMs));
  const manifest: DataManifest = {
    version: "1.0.0",
    datasetVersion: snapshot.descriptor.datasetVersion,
    lastUpdated: snapshot.descriptor.processedAtEpochMs,
    latestIngestionDate: snapshot.descriptor.sourceDate,
    totalEvents: snapshot.model.events.length,
    totalArtists: snapshot.model.artists.length,
    totalVenues: snapshot.model.venues.length,
    dateRange: { startEpochMs: start, endEpochMs: end, startDate: new Date(start).toISOString().slice(0, 10), endDate: new Date(end).toISOString().slice(0, 10) },
    chunks: {
      events: events.map((event, index) => ({ ...fileInfo(event, chunks[index].events.length), chunkId: chunks[index].chunkId, eventCount: chunks[index].events.length, dateRange: chunks[index].dateRange })),
      artists: fileInfo(artists, snapshot.model.artists.length),
      venues: fileInfo(venues, snapshot.model.venues.length),
      indexes: fileInfo(indexes, 0),
    },
    processedAt: snapshot.descriptor.processedAtEpochMs,
    sourceFiles: {
      events: { filename: "events.txt", size: 0, lastModified: snapshot.descriptor.processedAtEpochMs, lineCount: 0, checksum: snapshot.descriptor.sourceChecksum },
      venues: { filename: "venues.txt", size: 0, lastModified: snapshot.descriptor.processedAtEpochMs, lineCount: 0, checksum: snapshot.descriptor.sourceChecksum },
    },
    schemaVersion: snapshot.descriptor.schemaVersion,
  };
  return { manifest, artifacts, chunks };
}

export function exportFingerprint(exported: StaticExport, descriptor: SnapshotDescriptor): string {
  const hash = createHash("sha256");
  hash.update(descriptor.snapshotId);
  hash.update(String(descriptor.sequence));
  for (const item of exported.artifacts) hash.update(item.bytes);
  return hash.digest("hex");
}
