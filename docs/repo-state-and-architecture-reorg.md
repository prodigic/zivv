# Zivv Repository State and Architecture Reorganization Plan

**Review date:** 2026-08-11
**Repository version:** 0.74.0
**Scope:** repository layout, runtime, ETL/data model, generated data contract, tests/CI, issue backlog, and the proposed role for DuckDB.

## Executive summary

Zivv is a working static event-discovery application with event lists, calendar routes, artist and venue directories, detail pages, newsletter/local-artist pages, filtering, search, IndexedDB caching, error handling, Storybook, Vitest, and Playwright coverage. The deployment model is GitHub Pages: source text is processed into checked-in JSON, and the browser loads those files directly.

The codebase is ready for an architectural cleanup, but the main problem is not the absence of DuckDB. Responsibilities currently overlap:

- ETL, browser services, the worker, Zustand stores, pages, and generated indexes each contain parts of the data/query model.
- DataService owns in-memory maps while appStore copies the same data into another set of maps.
- Query behavior is distributed across DataService, the worker, appStore, and page-local useMemo functions.
- The generated data contract is not self-validating: manifest metadata is computed from different representations than the files written, and indexes.json metadata is deliberately initialized from {}.
- Planning docs describe FullCalendar, MiniSearch, React 18, and phase work that no longer exactly matches the implementation or package.json.

### Recommendation

Make DuckDB the canonical normalized store for ingestion/builds, not the first browser-side replacement for JSON and IndexedDB.

~~~text
source text + curation files
        |
        v
raw/staging tables -> normalized DuckDB tables -> SQL views/read models
                                      |
                                      +-> static JSON/Parquet export for GitHub Pages
                                      +-> optional API or DuckDB-Wasm later
~~~

This provides relational integrity, explicit joins, better provenance, history, and SQL-based data-quality checks while preserving the current static delivery mechanism. DuckDB-Wasm should be considered later if product requirements justify local analytics or complex ad-hoc queries; it should not be added solely to replace filtering over roughly 3,681 events.

## 1. Current state

### 1.1 Deployment and data snapshot

The application is a React/Vite SPA deployed to GitHub Pages under /zivv/. There is no runtime application server or database connection. IndexedDB is a browser cache, not the canonical store.

The checked-in public/data/manifest.json describes:

| Measure | Value |
|---|---:|
| Events | 3,681 |
| Artists | 6,855 |
| Venues | 606 |
| Monthly event chunks | 15 |
| Event date range | 2026-01-04 to 2027-05-16 |
| Latest ingestion date | 2026-08-07 |
| Source event lines | 4,321 |
| Source venue lines | 730 |
| Largest generated files | artists.json 3.7 MB; search-documents.json 2.4 MB |

This is enough data to benefit from a better model, but not so much that static JSON is inherently wrong. The immediate risk is complexity/correctness rather than raw scale.

The worktree was clean before this document was added. It was detached at HEAD, pointing at the same commit as main and origin/main.

### 1.2 Repository responsibilities

| Area | Location | Responsibility | Assessment |
|---|---|---|---|
| Inputs | data/ | Event/venue text, aliases, corrections, local-artist lists | Good source boundary; rules are implicit |
| ETL | src/lib/etl/ | Parsing, normalization, derived fields, indexes, chunks, search files | Real data core, but broad and coupled |
| Scripts | scripts/ | ETL invocation, update/merge, validation, dev-server management | Duplicated ingestion paths and build assumptions |
| Public dataset | public/data/ | Manifest, monthly events, entities, indexes, search files | Good static shape; metadata needs hardening |
| Browser data | src/services/DataService.ts | Fetch, retry, IndexedDB, maps, loading, query helpers | Too many responsibilities; incomplete query paths |
| Cache | src/services/CacheService.ts | IndexedDB storage, expiration, eviction | Useful, but should implement a storage port |
| Worker | src/services/WorkerService.ts, src/workers/dataWorker.ts | Parsing, filtering, sorting, search, stats | Large but not the main app path; incomplete behavior |
| Global state | src/stores/appStore.ts | Data copies, loading/errors, UI state, service lifecycle | Couples data and UI state |
| Filters | src/stores/filterStore.ts | Filter/search state, persistence, URL sync | Good candidate for a UI-only boundary |
| UI | src/pages/, src/components/ | Rendering plus page-local queries and loading decisions | Domain logic is spread across features |
| Tests | src/test/, tests/ | Unit/integration, E2E, performance, Storybook | Broad surface; not runnable in this shell |

### 1.3 Current ingestion flow

ETLProcessor.processData() currently:

1. Reads data/events.txt and data/venues.txt.
2. Parses through EventParser and VenueParser.
3. Loads venue aliases and normalizes Event, Artist, and Venue records.
4. Preserves createdAtEpochMs for IDs found in prior generated chunks.
5. Computes upcoming counts and embeds upcoming-event summaries into artists and venues.
6. Builds lookup indexes with DataIndexer.
7. Splits events into monthly chunks with DataChunker.
8. Builds custom search documents and term maps.
9. Writes JSON files into public/data/.

The pipeline is conceptually sound. The main model issue is that canonical entities and derived read models are mixed: artists and venues are mutated to contain time-dependent event projections, then published as if those projections were canonical data.

### 1.4 Current browser flow

appStore.initialize() creates a DataService, initializes IndexedDB, and loads the manifest, artists, venues, indexes, and local-artist lists. DataService.initialize() also loads the manifest and each core loader calls loadManifest() again, so startup can repeat manifest fetch/cache work.

Pages then load monthly chunks, copy returned events into the Zustand events map, and derive results with page-local filters/sorts:

~~~text
React page
  -> Zustand selector
    -> copied Map/Set state in appStore
      -> DataService action
        -> IndexedDB cache or static JSON
~~~

The result is not one query layer. A page can be correct for records already loaded while being wrong for the complete dataset.

## 2. Strengths to preserve

### Data and domain

- Explicit parser, validator, sanitizer, indexer, and utility modules.
- Branded TypeScript IDs for events, artists, and venues.
- Source line numbers and raw-text context for data-quality diagnostics.
- Venue aliases and line corrections that acknowledge real identity-resolution work.
- Monthly event chunks that fit static delivery.
- Generated output committed to repository history, making production data reproducible.

### Frontend and operations

- Route-level lazy loading.
- Explicit loading/error states and error boundaries.
- Zustand persistence limited mostly to UI state.
- Dataset-versioned IndexedDB invalidation concept.
- Responsive/accessibility-oriented components and multiple navigation surfaces.
- Unit, integration, E2E, performance, and Storybook testing layers.
- Separate ETL and deployment workflows.

The reorganization should reduce duplication without discarding these capabilities.

## 3. Findings and risks

### High: query correctness depends on loaded chunks

DataService.searchEvents() finds event IDs through indexes and then calls getChunksForEventIds(). That helper derives chunk IDs only from events already in the in-memory map. On a cold start, matching events are not present, so search can return no results even when the index contains matches.

DataService.findChunkForEvent() is a stub that always returns null. Therefore getEvent(eventId) cannot resolve an unloaded event by ID. EventDetailPage works around this by scanning chunks sequentially, prioritizing the month encoded in the slug.

Fix this before changing storage. A repository query should either return complete results or explicitly load the necessary partition based on manifest ranges or an event-to-chunk index.

### High: manifest metadata is not authoritative

ETLProcessor.createManifest() computes file metadata from compact JSON.stringify() output while writeJSON() writes pretty-printed JSON. The checked-in data proves the mismatch: events-2026-05.json reports 356,461 bytes but is 518,051 bytes on disk.

The manifest also sets indexes from {} with the comment “Will be filled after writing,” but no later step fills it. It reports indexes.json as 2 bytes although the file is approximately 914 KB.

This affects cache sizing, integrity checks, monitoring, and any future export/import process. Fix it before treating the manifest as a store contract.

### High: two application data stores exist

DataService maintains private maps for events, artists, venues, and chunks. appStore maintains another set of maps and copies service data into them. Pages read the store maps while some operations still call the service through store actions.

Consequences:

- duplicated memory;
- possible service/store divergence;
- store actions coupled to service lifecycle;
- harder cache invalidation and refresh;
- tests that mock both the service and browser storage.

The target should have one repository/query layer and a separate UI state store. The UI store should contain filters, view state, loading state, and query results/keys—not the canonical entity graph.

### Medium: worker paths are incomplete and disconnected

The worker is substantial, but normal page filtering does not use WorkerService. The worker city filter calls getVenueCity(), which returns an empty string because venue data is not passed to it. Worker text search considers only description and notes, not artist and venue fields. The main-thread fallback implements only a basic free-event filter.

Do not add more worker features until there is one query implementation with a tested contract. Decide afterward whether it runs on the main thread, a worker, DuckDB-Wasm, or a server.

### Medium: page components own domain/query behavior

HomePage, CalendarPage, ArtistsPage, and VenuesPage contain combinations of date parsing, city normalization, filtering, sorting, paging, chunk loading, and scroll behavior. City normalization is repeated with different mappings and fallbacks.

Move these rules into domain/query modules. Pages should use operations such as useEventsQuery(filters) and render view models.

### Medium: canonical entities and projections are mixed

Embedded upcomingEvents arrays and counts are useful directory projections, but they are time-dependent and can become stale as the clock moves or an event status changes. They should not be the canonical artist/venue representation.

Keep canonical artists, venues, events, and relationships separately. Generate directory summaries as SQL views or export projections.

### Medium: documentation and implementation have diverged

The README/PRD describe React 18, FullCalendar, and MiniSearch. The actual package uses React 19 and react-virtuoso; FullCalendar and MiniSearch are not in package.json, and current calendar/search code is custom. The Beads backlog contains phase tickets for features that are already partially implemented.

Update the architecture decision, README, roadmap, and issue backlog before the next large migration.

### Lower: workflow and data-quality fragility

- Several scripts import compiled files from dist/, so commands depend on a prior TypeScript build.
- update-data.js and merge-latest.js overlap but have different dedupe behavior.
- ETL uses Node 18 while deployment uses Node 20; define one support policy.
- The checksum is labeled sha256-* but is a lightweight integer hash, not SHA-256.
- Date calculations mix epoch values with local-time Date operations despite an explicit timezone field.

## 4. Target architecture

### 4.1 Separation by lifecycle

~~~text
apps/web
  routes/components/state
        |
        v
query use-cases + view models
        |
        v
repository ports
  JSON | DuckDB | DuckDB-Wasm/API later
        |
        v
static read models or relational projections

source files -> ingestion -> normalization -> canonical store -> export
~~~

Suggested shape after incremental extraction:

~~~text
apps/web/src/
  features/
  routes/
  components/
  state/
  adapters/

packages/domain/
packages/ingestion/
packages/normalization/
packages/store-duckdb/
packages/store-json/
packages/export-static/
packages/query/
packages/test-fixtures/

scripts/
data/source/
data/curation/
docs/adr/
~~~

Initially, these can be folders under the existing src/ tree. A workspace/package split should wait until boundaries are stable.

### 4.2 Dependency rules

- domain imports no React, Vite, browser APIs, DuckDB, or filesystem code.
- ingestion imports domain types and source-specific parsers.
- normalization imports domain types and curation data, not UI code.
- store-duckdb and store-json implement the same repository ports.
- query contains use-cases and mapping to view models; it depends on ports, not concrete storage.
- apps/web depends on query use-cases; pages do not parse raw data or perform identity resolution.
- scripts compose modules; they do not contain domain rules.

### 4.3 Repository ports

Define the seam before adding DuckDB:

~~~typescript
interface EventRepository {
  getById(id: EventId): Promise<Event | null>;
  findBySlug(slug: string): Promise<Event | null>;
  search(query: EventSearch): Promise<Paginated<EventSummary>>;
  list(filters: EventFilters): Promise<Paginated<EventSummary>>;
  listByMonth(month: YearMonth): Promise<EventSummary[]>;
}

interface ArtistRepository {
  list(filters: ArtistFilters): Promise<Paginated<ArtistSummary>>;
  getBySlug(slug: string): Promise<ArtistDetail | null>;
}

interface VenueRepository {
  list(filters: VenueFilters): Promise<Paginated<VenueSummary>>;
  getBySlug(slug: string): Promise<VenueDetail | null>;
}
~~~

Implement the JSON repository first. Once the UI uses these ports, a DuckDB adapter can be added without changing page components.

## 5. DuckDB strategy

### 5.1 Recommended role: build-time canonical store

Use DuckDB during ETL/builds:

1. Load raw input into staging tables.
2. Normalize identities into canonical tables.
3. Run SQL validation and data-quality queries.
4. Build read-model views.
5. Export JSON/Parquet for GitHub Pages.
6. Record dataset version, schema version, source checksums, row counts, and exact export checksums in the manifest.

Do not commit a DuckDB binary as the only production artifact unless there is a clear operational reason. Generate it reproducibly in CI/local builds and retain it as an artifact when useful.

This fits the current static architecture: it improves the source of truth without adding a server, connection layer, auth, or a browser database download.

### 5.2 Proposed relational model

Start with:

~~~sql
ingestion_runs(run_id, dataset_version, source_checksums, schema_version, status)
raw_event_lines(run_id, source_line_number, raw_text, parse_status, parse_error)
artists(artist_id, stable_key, slug, name, normalized_name, created_at, updated_at)
artist_aliases(artist_id, alias, normalized_alias)
venues(venue_id, stable_key, slug, name, normalized_name, address, city, timezone, ...)
events(event_id, stable_key, slug, event_date, start_time, timezone, venue_id,
       headliner_artist_id, price_min, price_max, is_free, age_restriction,
       status, description, notes, ticket_url, source_line_number, raw_text, ...)
event_artists(event_id, artist_id, billing_order)
event_tags(event_id, tag)
~~~

Important changes:

- artists and venues do not own embedded event arrays;
- event/artist relationships are first-class rows;
- raw source and lineage are retained;
- stable_key is explicit and testable independently of display IDs;
- date-only and timezone semantics are explicit;
- upcoming counts/lists are projections, not canonical fields.

### 5.3 Read-model exports

Do not make the UI speak normalized SQL rows immediately. Export views shaped for the current features:

- event_summary: card-ready events with joined headliner, venue, city, price, age, and tags;
- event_detail: one event with joined venue and ordered artists;
- artist_summary and venue_summary: directory rows with counts and next-show metadata;
- event_search: searchable documents;
- events_by_month: chunk/index projection;
- dataset_facets: cities, ages, tags, and price ranges.

The first exporter can keep the current filenames. The data model improves without forcing a simultaneous UI rewrite.

### 5.4 DuckDB-Wasm decision

DuckDB-Wasm is technically viable for browser queries. The official docs describe a WebAssembly client that runs in browsers, defaults to single-threaded behavior, has browser/memory limits, and requires shipping library, worker, and Wasm components. The docs also describe browser CORS constraints and no durable cross-session storage for extension installation.

Choose DuckDB-Wasm only if benchmarks show value from:

- arbitrary filter/join combinations;
- local analytics, charts, or export;
- one browser query engine for events, artists, venues, and history;
- offline exploration of a meaningfully larger dataset.

Keep JSON/Parquet if the priorities remain fast initial render, cacheable month downloads, simple discovery queries, and broad mobile compatibility. Hide either choice behind repository ports.

For Node ETL, use the current DuckDB Node Neo client (@duckdb/node-api) rather than the deprecated legacy duckdb package, after confirming native binary/CI support for the repository’s OS and Node matrix.

## 6. Migration plan

### Phase 0: trustworthy baseline

1. Compute manifest metadata from the exact bytes written.
2. Use real SHA-256 or rename the checksum field.
3. Add a generated-data contract test for all manifest references, counts, checksums, date ranges, and foreign keys.
4. Fix cold-start search and event-by-ID loading.
5. Add fixtures for unloaded data, multiple artists, aliases, free/no-price events, sold-out events, and time-zone boundaries.
6. Capture baseline startup, transferred bytes, first render, search latency, and memory.

### Phase 1: domain and query boundaries

- Move canonical entities, filter/value types, city normalization, and date policy out of frontend-specific modules.
- Introduce JSON repository adapters.
- Make the Zustand store UI/query state, not the entity graph.
- Move page filtering/sorting into query modules.
- Remove page-local normalization duplication.

### Phase 2: DuckDB shadow store

- Keep the existing TypeScript parsers.
- Write parser output to DuckDB staging tables.
- Normalize into canonical tables and SQL projections.
- Export the current JSON contract.
- Diff old and new exports by stable keys and normalized values.
- Fail CI on unexpected row loss, duplicates, broken relations, or unexplained large deltas.

### Phase 3: DuckDB as ETL authority

- Make DuckDB canonical for normalized/derived data.
- Version schema migrations separately from dataset versions.
- Generate data-quality reports from SQL.
- Remove duplicate index construction where SQL projections cover the use case.
- Keep JSON/Parquet as an explicit public delivery contract.
- Reduce scripts to thin pipeline commands.

### Phase 4: client-store benchmark

Compare JSON+IndexedDB, DuckDB-Wasm, and a future API adapter against the same query suite. Measure cold/warm startup, transferred bytes, peak memory, query latency, mobile behavior, compatibility, and deployment complexity. Choose DuckDB-Wasm only if the query benefits outweigh its asset/startup cost.

## 7. Immediate next steps

| Order | Task | Acceptance outcome |
|---:|---|---|
| 1 | Record an ADR for “DuckDB build-time canonical store; static read models first” | Working architecture decision is explicit |
| 2 | Repair manifest size/checksum/index metadata | Generated data is verifiable |
| 3 | Add generated-data contract tests | Broken exports fail before deploy |
| 4 | Fix chunk lookup/search from a cold cache | Deep links and search are correct |
| 5 | Define canonical types and date policy | Normalization rules have one owner |
| 6 | Add repository/query ports and JSON adapter | Storage seam exists before DuckDB |
| 7 | Move page query logic into use-cases | Pages render view models |
| 8 | Repair or quarantine worker paths | One tested filter/search implementation |
| 9 | Add DuckDB staging/canonical schema | Relational shadow store exists |
| 10 | Export and diff DuckDB-backed JSON | Migration equivalence is proven |
| 11 | Reconcile README, PRD, roadmap, and Beads backlog | Project status becomes trustworthy |
| 12 | Benchmark DuckDB-Wasm | Client store choice is evidence-based |

### First milestone: Data Contract and Query Boundary

This should be the next milestone, not “Add DuckDB.” It is complete when:

- manifest metadata matches exact output files;
- every generated file loads and validates;
- cold-cache search works;
- event detail lookup does not scan every month;
- pages no longer own city/date/price normalization;
- a JSON repository implements the query interface;
- existing UI behavior is unchanged intentionally.

## 8. Testing strategy

### Domain tests

Test stable event keys, ID assignment, artist/venue normalization, aliases, date/time-zone handling, prices, free events, ages, tags, statuses, dedupe, and source-line provenance.

### Store contract tests

Run the same result-oriented test suite against JSON, DuckDB Node, and DuckDB-Wasm/API adapters. Assert result ordering, pagination, null/error behavior, and completeness—not implementation details.

### Export contract tests

For every manifest:

- verify exact bytes/checksums and record counts;
- verify every event venue/artist exists;
- verify projections reference valid IDs;
- verify chunk date ranges and event counts;
- verify no event appears in two chunks;
- verify time-dependent counts are internally consistent.

### E2E/performance additions

Add Playwright cases for empty-cache event deep links, search before chunk loading, venue/supporting-artist search, dataset-version refresh, and slow mobile startup. Add gates for startup request count, bytes before first event, cold-search latency, memory after six months, and adapter disposal/refresh.

## 9. Decisions to avoid for now

- Do not make DuckDB-Wasm a hard dependency of every page before measuring bundle/startup impact.
- Do not expose SQL directly to React components.
- Do not treat embedded upcoming arrays as canonical data.
- Do not combine a monolithic folder move, deployment change, and database migration.
- Do not delete static JSON until the new adapter passes the same contract and E2E tests.
- Do not introduce a remote database unless scope includes mutable user data, admin workflows, real-time updates, or server-side APIs.

## 10. Verification notes

The repository, source, generated data, docs, workflows, and local Beads JSONL were inspected on 2026-08-11. The local Beads snapshot contained 37 open issues, 1 in progress, and 19 closed issues. The bd executable was not available.

Formal Node quality commands were not run because the shell does not expose node, npm, or npx, and project dependencies are absent from node_modules. A bundled Node runtime was found, but offline installation could not resolve all dependencies. This document reports static inspection and generated-data checks, not a fresh lint/test/build result.

Key implementation references:

- src/lib/etl/processor.ts — ETL orchestration, projections, manifest creation, and JSON writing.
- src/lib/etl/indexer.ts — indexes, monthly chunks, and custom search documents.
- src/services/DataService.ts — loading, caching, in-memory state, and query helpers.
- src/services/CacheService.ts — IndexedDB cache and eviction.
- src/services/WorkerService.ts, src/workers/dataWorker.ts — worker query paths and fallbacks.
- src/stores/appStore.ts, src/stores/filterStore.ts — global data/UI/filter state.
- src/pages/HomePage.tsx, CalendarPage.tsx, ArtistsPage.tsx, VenuesPage.tsx — page-local query logic.
- .github/workflows/etl.yml, .github/workflows/deploy.yml — build/deploy automation.

For implementation planning, see the official [DuckDB-Wasm overview](https://duckdb.org/docs/stable/clients/wasm/overview), [DuckDB-Wasm deployment guidance](https://duckdb.org/docs/current/clients/wasm/deploying_duckdb_wasm), [DuckDB-Wasm query API](https://duckdb.org/docs/current/clients/wasm/query), and [DuckDB Node Neo client documentation](https://duckdb.org/docs/lts/clients/node_neo/overview).

## Conclusion

Reorganize around a clear distinction between canonical data, derived projections, storage adapters, query use-cases, and UI state. DuckDB is a good fit for the canonical build-time data layer because Zivv already has an ETL boundary, relational entities, provenance needs, and growing derived-query complexity. The safest path is dual-output migration: stabilize the current contract, introduce repository ports, build DuckDB as a shadow store, compare exports, then make DuckDB authoritative for ETL while keeping the browser delivery format independent.

This preserves the current static deployment strengths while creating a durable base for better search, data quality, history, future APIs, and—if benchmarks justify it—DuckDB-Wasm later.
