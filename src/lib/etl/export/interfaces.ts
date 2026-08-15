import type { Artist, Event, Venue, EventChunk } from "@/types/events.js";
import type { DataIndexes, ChunkInfo } from "@/types/data.js";
import { DataChunker, DataIndexer, SearchIndexBuilder } from "../indexer.js";

export interface ExportInput {
  events: Event[];
  artists: Artist[];
  venues: Venue[];
}

export interface ExportArtifact<T> {
  name: string;
  value: T;
}

export interface Exporter<T> {
  readonly name: string;
  export(input: ExportInput): ExportArtifact<T>;
}

export interface DefaultExportSet {
  indexes: DataIndexes;
  chunks: EventChunk[];
  chunkInfos: ChunkInfo[];
  searchDocuments: unknown[];
  searchTerms: Record<string, number[]>;
}

export const indexExporter: Exporter<DataIndexes> = {
  name: "indexes",
  export(input) {
    return { name: "indexes.json", value: DataIndexer.buildIndexes(input.events, input.artists, input.venues) };
  },
};

export const chunkExporter: Exporter<{ chunks: EventChunk[]; chunkInfos: ChunkInfo[] }> = {
  name: "monthly-event-chunks",
  export(input) {
    return { name: "events-*.json", value: DataChunker.chunkEventsByMonth(input.events) };
  },
};

export const searchExporter: Exporter<{ documents: unknown[]; terms: Record<string, number[]> }> = {
  name: "search-index",
  export(input) {
    return { name: "search-*.json", value: SearchIndexBuilder.buildSearchIndex(input.events, input.artists, input.venues) };
  },
};

export function buildDefaultExports(input: ExportInput): DefaultExportSet {
  const indexes = indexExporter.export(input).value;
  const chunks = chunkExporter.export(input).value;
  const search = searchExporter.export(input).value;
  return {
    indexes,
    chunks: chunks.chunks,
    chunkInfos: chunks.chunkInfos,
    searchDocuments: search.documents,
    searchTerms: search.terms,
  };
}
