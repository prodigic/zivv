/**
 * Deterministic keys for browser-resident dataset artifacts.
 *
 * The key is scoped to Zivv's dataset namespace and the logical resource. The
 * dataset version remains a separate CachePort field so a version transition
 * can be invalidated with clearVersion without depending on key parsing.
 */
export const DATASET_CACHE_NAMESPACE = "zivv:dataset";

export type DatasetCacheResource =
  | "manifest"
  | "indexes"
  | "artists"
  | "venues"
  | "search-documents"
  | `chunk:${string}`;

export function datasetCacheKey(resource: DatasetCacheResource): string {
  return `${DATASET_CACHE_NAMESPACE}:${resource}`;
}
