import { canonicalArtists, canonicalEvents, canonicalVenues, eventStableKey } from "./staging.js";
import { buildProjectionRows } from "./projections.js";
import type { CanonicalState, EventArtistRow, EventProjectionRow, EventTagRow, DirectoryProjectionRow, SearchProjectionRow, StagedSnapshot } from "./types.js";

function upsert<T>(target: Map<string, T>, rows: readonly T[], key: (row: T) => string): { inserted: number; updated: number } {
  let inserted = 0;
  let updated = 0;
  for (const row of rows) {
    const rowKey = key(row);
    if (target.has(rowKey)) updated += 1;
    else inserted += 1;
    target.set(rowKey, row);
  }
  return { inserted, updated };
}

export class InMemoryCanonicalState {
  private readonly snapshots = new Map<string, StagedSnapshot["descriptor"]>();
  private readonly events = new Map<string, ReturnType<typeof canonicalEvents>[number]>();
  private readonly artists = new Map<string, ReturnType<typeof canonicalArtists>[number]>();
  private readonly venues = new Map<string, ReturnType<typeof canonicalVenues>[number]>();
  private readonly eventArtists = new Map<string, EventArtistRow>();
  private readonly eventTags = new Map<string, EventTagRow>();
  private readonly eventProjections = new Map<string, EventProjectionRow>();
  private readonly directoryProjections = new Map<string, DirectoryProjectionRow>();
  private readonly searchProjections = new Map<string, SearchProjectionRow>();

  apply(snapshot: StagedSnapshot): { inserted: number; updated: number; replayed: boolean } {
    const replayed = this.snapshots.has(snapshot.descriptor.snapshotId)
      && this.snapshots.get(snapshot.descriptor.snapshotId)?.sourceChecksum === snapshot.descriptor.sourceChecksum;
    if (replayed) return { inserted: 0, updated: 0, replayed: true };
    this.snapshots.set(snapshot.descriptor.snapshotId, snapshot.descriptor);
    const projectionRows = buildProjectionRows(snapshot);
    const eventRows = canonicalEvents(snapshot);
    const artistRows = canonicalArtists(snapshot);
    const venueRows = canonicalVenues(snapshot);
    const counts = [
      upsert(this.events, eventRows, (row) => row.stableKey),
      upsert(this.artists, artistRows, (row) => row.stableKey),
      upsert(this.venues, venueRows, (row) => row.stableKey),
      upsert(this.eventArtists, projectionRows.eventArtists, (row) => `${row.eventStableKey}:${row.artistStableKey}`),
      upsert(this.eventTags, projectionRows.eventTags, (row) => `${row.eventStableKey}:${row.tag}`),
      upsert(this.eventProjections, projectionRows.eventProjections, (row) => `${row.eventStableKey}:${row.asOfEpochMs}`),
      upsert(this.directoryProjections, projectionRows.directoryProjections, (row) => `${row.entityType}:${row.entityStableKey}:${row.asOfEpochMs}`),
      upsert(this.searchProjections, projectionRows.searchProjections, (row) => row.documentKey),
    ];
    return {
      replayed,
      inserted: counts.reduce((sum, count) => sum + count.inserted, 0),
      updated: counts.reduce((sum, count) => sum + count.updated, 0),
    };
  }

  read(): CanonicalState {
    return {
      snapshots: Array.from(this.snapshots.values()).sort((left, right) => left.sequence - right.sequence),
      events: Array.from(this.events.values()).sort((left, right) => eventStableKey(left).localeCompare(eventStableKey(right))),
      artists: Array.from(this.artists.values()).sort((left, right) => left.stableKey.localeCompare(right.stableKey)),
      venues: Array.from(this.venues.values()).sort((left, right) => left.stableKey.localeCompare(right.stableKey)),
      eventArtists: sorted(this.eventArtists),
      eventTags: sorted(this.eventTags),
      eventProjections: sorted(this.eventProjections),
      directoryProjections: sorted(this.directoryProjections),
      searchProjections: sorted(this.searchProjections),
    };
  }
}

function sorted<T>(map: Map<string, T>): T[] {
  return Array.from(map.entries()).sort(([left], [right]) => left.localeCompare(right)).map(([, value]) => value);
}
