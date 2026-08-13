# Worker and browser-cache boundary

The data layer has two deliberately separate responsibilities:

| Boundary | Owns | Does not own |
| --- | --- | --- |
| `JsonDatasetReader` and repositories | same-origin reads, manifest/index lookup, chunk selection, entity identity, query ordering/pagination, and cache access | UI state, navigation, accounts, telemetry, or remote error reporting |
| `CachePort` / `IndexedDbCacheAdapter` | browser-local persistence, dataset-version matching, invalidation, and cache lifecycle | network requests, user identifiers, query history, or server synchronization |
| `WorkerDataProcessor` / `WorkerService` / `dataWorker` | CPU-heavy JSON validation, filtering, sorting, search-index construction, and statistics | fetching, IndexedDB, cache keys, dataset version decisions, and user/session state |

The worker is optional. A repository can run with no `Worker` support, and
`WorkerService` already falls back to local main-thread implementations when a
worker is unavailable or fails. Those failures stay in the browser and are
reported only through local console diagnostics; there is no telemetry or
remote error sink.

## Cache rules

- Dataset artifacts use the deterministic `zivv:dataset:<resource>` key
  namespace.
- The dataset version is stored as cache metadata and is checked on every
  version-aware read. A mismatch is a local cache miss and the stale entry is
  removed.
- `clearVersion(version)` remains available for explicit refresh/version
  transitions and preserves the existing IndexedDB implementation.
- Cache entries contain only public dataset artifacts. No user actions,
  filters, search strings, or navigation state are cache keys or values.

## Integration pattern

Inject `WorkerDataProcessor` into `JsonDatasetReader` when a browser worker is
desired:

```ts
const reader = new JsonDatasetReader({
  processor: new WorkerDataProcessor(),
});
```

The reader fetches and caches the response; the processor receives only the
response body for validation/parsing. Search/filter/sort operations may use
the same port after repository data has been loaded. Call `reader.close()` at
the end of the reader lifecycle to release both the worker and IndexedDB
connection.
