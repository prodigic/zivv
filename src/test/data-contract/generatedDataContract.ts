import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { DataManifest } from "@/types/data.js";
import { repositoryRoot } from "./fixtures.js";

export interface ContractViolation {
  code:
    | "missing-file"
    | "metadata-size"
    | "metadata-checksum"
    | "record-count"
    | "chunk-count"
    | "chunk-date-range"
    | "duplicate-event"
    | "orphan-event-artist"
    | "orphan-event-venue"
    | "orphan-index-event"
    | "orphan-index-artist"
    | "orphan-index-venue"
    | "orphan-projection";
  path: string;
  message: string;
}

interface EventRecord {
  id: number | string;
  date?: string;
  dateEpochMs?: number;
  venueId?: number | string;
  artistIds?: Array<number | string>;
}

interface EntityRecord {
  id: number | string;
  upcomingEvents?: Array<{ id?: number | string; venueId?: number | string }>;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function key(value: unknown): string {
  return String(value);
}

function legacyChecksum(text: string): string {
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash << 5) - hash + text.charCodeAt(index);
    hash &= hash;
  }
  return `sha256-${Math.abs(hash).toString(16)}`;
}

function add(
  violations: ContractViolation[],
  code: ContractViolation["code"],
  path: string,
  message: string
): void {
  violations.push({ code, path, message });
}

function readJson(
  dataDirectory: string,
  filename: string,
  violations: ContractViolation[]
): unknown | undefined {
  const path = join(dataDirectory, filename);
  if (!existsSync(path)) {
    add(violations, "missing-file", filename, `Manifest references missing file: ${filename}`);
    return undefined;
  }

  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (error) {
    add(violations, "missing-file", filename, `Unable to parse ${filename}: ${String(error)}`);
    return undefined;
  }
}

function checkFileMetadata(
  dataDirectory: string,
  filename: string,
  metadata: { size?: number; checksum?: string; recordCount?: number },
  actual: unknown,
  violations: ContractViolation[]
): void {
  const raw = readFileSync(join(dataDirectory, filename), "utf8");
  const actualSize = Buffer.byteLength(raw, "utf8");
  if (metadata.size !== actualSize) {
    add(
      violations,
      "metadata-size",
      filename,
      `Manifest size ${metadata.size} does not match served bytes ${actualSize}`
    );
  }

  const actualChecksum = legacyChecksum(raw);
  if (metadata.checksum !== actualChecksum) {
    add(
      violations,
      "metadata-checksum",
      filename,
      `Manifest checksum ${metadata.checksum} does not match served bytes ${actualChecksum}`
    );
  }

  if (metadata.recordCount !== undefined && Array.isArray(actual)) {
    if (metadata.recordCount !== actual.length) {
      add(
        violations,
        "record-count",
        filename,
        `Manifest record count ${metadata.recordCount} does not match ${actual.length}`
      );
    }
  }
}

function checkReference(
  violations: ContractViolation[],
  exists: Set<string>,
  value: unknown,
  code: ContractViolation["code"],
  path: string,
  label: string
): void {
  if (!exists.has(key(value))) {
    add(violations, code, path, `${label} ${String(value)} does not resolve`);
  }
}

export function validateGeneratedData(
  dataDirectory = join(repositoryRoot, "public", "data")
): ContractViolation[] {
  const violations: ContractViolation[] = [];
  const manifest = JSON.parse(
    readFileSync(join(dataDirectory, "manifest.json"), "utf8")
  ) as DataManifest;

  const eventRecords: EventRecord[] = [];
  const eventIds = new Set<string>();
  const artistValue = readJson(dataDirectory, manifest.chunks.artists.filename, violations);
  const venueValue = readJson(dataDirectory, manifest.chunks.venues.filename, violations);
  const indexValue = readJson(dataDirectory, manifest.chunks.indexes.filename, violations);
  const artists = asArray<EntityRecord>(artistValue);
  const venues = asArray<EntityRecord>(venueValue);
  const artistIds = new Set(artists.map((artist) => key(artist.id)));
  const venueIds = new Set(venues.map((venue) => key(venue.id)));
  const eventChunkIds = new Set<string>();

  for (const chunkInfo of manifest.chunks.events) {
    const chunkValue = readJson(dataDirectory, chunkInfo.filename, violations);
    const chunk = asRecord(chunkValue);
    const events = asArray<EventRecord>(chunk.events);
    eventChunkIds.add(chunkInfo.chunkId);

    if (chunkInfo.eventCount !== events.length) {
      add(
        violations,
        "chunk-count",
        chunkInfo.filename,
        `Manifest event count ${chunkInfo.eventCount} does not match ${events.length}`
      );
    }

    if (events.length > 0) {
      const timestamps = events
        .map((event) => event.dateEpochMs)
        .filter((timestamp): timestamp is number => typeof timestamp === "number")
        .sort((a, b) => a - b);
      const actualStart = timestamps[0];
      const actualEnd = timestamps[timestamps.length - 1];
      if (
        actualStart !== chunkInfo.dateRange.startEpochMs ||
        actualEnd !== chunkInfo.dateRange.endEpochMs
      ) {
        add(
          violations,
          "chunk-date-range",
          chunkInfo.filename,
          `Manifest date range does not match event timestamps`
        );
      }
    }

    if (chunkValue !== undefined) {
      checkFileMetadata(dataDirectory, chunkInfo.filename, chunkInfo, chunkValue, violations);
    }

    for (const event of events) {
      const eventKey = key(event.id);
      if (eventIds.has(eventKey)) {
        add(violations, "duplicate-event", chunkInfo.filename, `Event ${eventKey} appears in more than one chunk`);
      }
      eventIds.add(eventKey);
      eventRecords.push(event);
    }
  }

  if (manifest.totalEvents !== eventRecords.length) {
    add(violations, "chunk-count", "manifest.json", `Manifest totalEvents does not match chunk records`);
  }
  if (manifest.totalArtists !== artists.length) {
    add(violations, "record-count", "manifest.json", `Manifest totalArtists does not match artists.json`);
  }
  if (manifest.totalVenues !== venues.length) {
    add(violations, "record-count", "manifest.json", `Manifest totalVenues does not match venues.json`);
  }

  const artistMetadata = manifest.chunks.artists;
  const venueMetadata = manifest.chunks.venues;
  const indexMetadata = manifest.chunks.indexes;
  if (artistValue !== undefined) checkFileMetadata(dataDirectory, artistMetadata.filename, artistMetadata, artistValue, violations);
  if (venueValue !== undefined) checkFileMetadata(dataDirectory, venueMetadata.filename, venueMetadata, venueValue, violations);
  if (indexValue !== undefined) checkFileMetadata(dataDirectory, indexMetadata.filename, indexMetadata, indexValue, violations);

  for (const event of eventRecords) {
    checkReference(violations, venueIds, event.venueId, "orphan-event-venue", `event:${event.id}`, "Venue");
    for (const artistId of event.artistIds ?? []) {
      checkReference(violations, artistIds, artistId, "orphan-event-artist", `event:${event.id}`, "Artist");
    }
  }

  for (const artist of artists) {
    for (const projection of artist.upcomingEvents ?? []) {
      checkReference(violations, eventIds, projection.id, "orphan-projection", `artist:${artist.id}`, "Projected event");
    }
  }
  for (const venue of venues) {
    for (const projection of venue.upcomingEvents ?? []) {
      checkReference(violations, eventIds, projection.id, "orphan-projection", `venue:${venue.id}`, "Projected event");
    }
  }

  const indexes = asRecord(indexValue);
  for (const [date, ids] of Object.entries(asRecord(indexes.eventsByDate))) {
    for (const eventId of asArray<unknown>(ids)) {
      checkReference(violations, eventIds, eventId, "orphan-index-event", `indexes.eventsByDate.${date}`, "Indexed event");
    }
  }
  for (const [venueId, ids] of Object.entries(asRecord(indexes.eventsByVenue))) {
    checkReference(violations, venueIds, venueId, "orphan-index-venue", `indexes.eventsByVenue.${venueId}`, "Indexed venue");
    for (const eventId of asArray<unknown>(ids)) {
      checkReference(violations, eventIds, eventId, "orphan-index-event", `indexes.eventsByVenue.${venueId}`, "Indexed event");
    }
  }
  for (const [artistId, ids] of Object.entries(asRecord(indexes.eventsByArtist))) {
    checkReference(violations, artistIds, artistId, "orphan-index-artist", `indexes.eventsByArtist.${artistId}`, "Indexed artist");
    for (const eventId of asArray<unknown>(ids)) {
      checkReference(violations, eventIds, eventId, "orphan-index-event", `indexes.eventsByArtist.${artistId}`, "Indexed event");
    }
  }
  for (const [city, ids] of Object.entries(asRecord(indexes.eventsByCity))) {
    for (const eventId of asArray<unknown>(ids)) {
      checkReference(violations, eventIds, eventId, "orphan-index-event", `indexes.eventsByCity.${city}`, "Indexed event");
    }
  }
  for (const [name, artistId] of Object.entries(asRecord(indexes.artistsByName))) {
    checkReference(violations, artistIds, artistId, "orphan-index-artist", `indexes.artistsByName.${name}`, "Indexed artist");
  }
  for (const [name, venueId] of Object.entries(asRecord(indexes.venuesByName))) {
    checkReference(violations, venueIds, venueId, "orphan-index-venue", `indexes.venuesByName.${name}`, "Indexed venue");
  }
  for (const [city, ids] of Object.entries(asRecord(indexes.venuesByCity))) {
    for (const venueId of asArray<unknown>(ids)) {
      checkReference(violations, venueIds, venueId, "orphan-index-venue", `indexes.venuesByCity.${city}`, "Indexed venue");
    }
  }

  return violations;
}
