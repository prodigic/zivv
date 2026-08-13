# ADR 0001: DuckDB as the build-time canonical store

- Status: Accepted for the reorganization
- Date: 2026-08-13
- Scope: ingestion, normalization, data quality, and static export

## Context

Zivv is deployed as a static React/Vite application on GitHub Pages. The browser currently reads checked-in JSON files and may cache them in IndexedDB. There is no runtime application server, mutable user account model, or production database connection.

The current ETL pipeline already has relational concepts—events, artists, venues, relationships, aliases, source provenance, monthly partitions, indexes, and search projections—but those responsibilities are spread across parsers, normalizers, scripts, and generated JSON writers. Canonical entities are also mixed with time-dependent projections such as upcoming-event arrays.

The repository needs stronger identity, relationship, provenance, and data-quality guarantees without making the browser dependent on a database server or forcing a large client-side database download.

## Decision

DuckDB will become the canonical normalized store for build-time ingestion and export.

The build pipeline will be shaped as:

```text
source text and curation
        -> staging/raw records
        -> normalized canonical tables
        -> SQL quality checks and projections
        -> static JSON/Parquet read-model export
        -> GitHub Pages browser application
```

The first implementation will preserve the existing static JSON delivery contract. The React application will consume repository/query ports, with JSON as the first adapter. DuckDB is not a browser runtime dependency in this phase.

The initial implementation deliberately keeps `@duckdb/node-api` optional. The repository now defines the build-store schema, staging/canonical/projection/export interfaces, a runtime capability probe, and a deterministic in-memory fallback. The fallback is used when the native package is not already available; it does not install dependencies or weaken the static JSON/privacy boundary. Native DuckDB execution can be wired to the same `BuildStore` contract after the supported Node/OS/CI matrix is verified.

DuckDB-Wasm is explicitly deferred until a benchmark compares JSON plus IndexedDB, DuckDB-Wasm, and any future API adapter against product-relevant queries and mobile startup behavior.

## Required canonical concepts

The DuckDB schema should include, at minimum:

- ingestion runs and source checksums;
- raw source lines with parse status and provenance;
- canonical artists and artist aliases;
- canonical venues and venue aliases;
- canonical events and stable keys;
- event-to-artist and event-to-tag relationships;
- source first-seen/last-seen metadata;
- schema version and dataset version;
- derived projections for event lists, directories, search documents, and monthly chunks.

Time-dependent upcoming counts and event arrays are projections, not canonical artist or venue fields.

## Export contract

Exporters must serialize the exact bytes that are written, then compute byte size and checksum metadata from those bytes. The manifest must identify the dataset version, schema version, output files, exact byte sizes, checksum algorithm, record counts, and date ranges.

The DuckDB export must pass the same contract tests as the existing JSON output:

- all manifest files exist;
- sizes and checksums match exact bytes;
- counts and date ranges match;
- events reference existing artists and venues;
- projections reference valid IDs;
- no event appears in multiple month chunks;
- repeated ingestion of the same snapshot is idempotent.

## Privacy and deployment boundary

This decision does not add a runtime server, user accounts, telemetry, analytics, or behavioral tracking. The public application remains static and read-only. User searches, filters, navigation, and local cache state must not be uploaded to the build store or any application service.

## Consequences

### Positive

- SQL constraints and checks make identity and referential errors visible during builds.
- Raw provenance and ingestion history have an explicit home.
- JSON and future Parquet exports can be generated from one canonical model.
- The browser delivery architecture remains cacheable, static, and broadly compatible.
- A future DuckDB-Wasm or API adapter can implement the same repository/query ports without changing page components.

### Negative

- The build toolchain gains a native DuckDB dependency and must verify supported Node/OS combinations.
- The team must maintain schema migrations separately from dataset versions.
- Export equivalence tests and row-level diffs add build complexity.
- Existing parser behavior must be preserved while the intermediate model is extracted.

## Migration sequence

1. Establish generated-data and repository contract tests.
2. Define domain entities, stable keys, date policy, and query ports.
3. Refactor ingestion into typed stages without changing semantics.
4. Load the normalized intermediate model into DuckDB staging and canonical tables.
5. Generate current JSON read models from DuckDB and compare by stable key.
6. Make DuckDB authoritative for build-time normalized data.
7. Benchmark browser storage/query alternatives before considering DuckDB-Wasm.

## Rejected alternatives

- A remote production database is out of scope because the current product is a static discovery application.
- Making DuckDB-Wasm the first migration would add bundle/startup complexity before a measured need exists.
- Keeping all canonical state in page-local maps and scripts preserves the current correctness and ownership problems.
