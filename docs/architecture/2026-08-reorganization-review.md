# Review brief: the August Zivv architecture experiment

Recorded October 13, 2026. This is a retrospective of an unmerged experiment,
not an adopted architecture decision or an instruction to migrate storage.
The architecture review issue should decide which parts to retain, adapt or
retire against current `main` and the automatic Friday loading/publication goal.

## Provenance and scope

- Preserved workspace: `1aeb`, branch `codex/fix-mobile-stale-cache`.
- Source head: `41c7e246288e84bed128db9f978ef4e2bc467f6d`.
- Work dates: August 11–13, 2026, initially based on Zivv 0.74.0.
- Current comparison baseline: `ed2af9d73c7a230ca87b78875fea07e55f835ccb`
  (`main`, version 0.91.0).
- [PR #3](https://github.com/prodigic/zivv/pull/3) is titled “Fix stale mobile
  data cache versioning”, but includes the preceding architecture work: 28
  commits outside main, 19 non-merge commits, and changes across 94 files.
  Its merge-base diff has approximately 22,640 insertions; 16,884 are seven
  historical weekly source snapshots, rather than application code.
- The workspace is clean. The branch and its component branches remain
  available as evidence; this document does not merge or delete them.

## Original intent

The assessment identified overlapping responsibilities in ETL, DataService,
Zustand state, workers and pages. DataService and appStore both held entity
maps; filtering/query behavior was spread across multiple layers. Results could
depend on which monthly chunks had already loaded. Canonical artist/venue
identity was mixed with time-dependent upcoming-show projections.

The proposed direction was to extract stable domain concepts and explicit
storage/query boundaries, make ingestion stages easier to reason about, and
validate exported files independently of the implementation producing them.
DuckDB was proposed as a build-time normalized store for joins, integrity and
projections while retaining static JSON delivery to the browser.

```text
Original proposed build path
  source text + curation
    → raw/staged records
    → normalized build store + quality checks
    → derived read models
    → static JSON export

Original proposed browser path
  pages + UI state
    → repository/query interfaces
    → JSON dataset reader
    → same-origin files + versioned local cache
       optional worker: parsing/filtering computation only
```

The expected benefit was clearer ownership and correctness, not a claim that
the existing dataset required a browser database. DuckDB-Wasm and a runtime
server were deferred.

## Changes actually present on the branch

| Area                        | Representative commit                                                                                                                                  | Intent and implementation                                                                                                                                                  |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Architecture assessment     | [`d9025fa`](https://github.com/prodigic/zivv/commit/d9025fa0836802901823b331bce90818ab9689d7) — `docs: assess repository architecture and DuckDB path` | Records the old system, responsibility overlaps, observed bugs and staged migration direction. Its counts and findings describe August, not current production.            |
| Historical source snapshots | [`cc1ac07`](https://github.com/prodigic/zivv/commit/cc1ac071d692cb68eb7952df71c2af00e17ca323) — `data: materialize weekly latest snapshots`            | Adds seven source editions under `data/steve/`. These are data/history artifacts; privacy and import provenance must be checked before reusing them.                       |
| Domain kernel               | [`81bc7c2`](https://github.com/prodigic/zivv/commit/81bc7c277fc08f05748e4d30ada52945675a2832) — `reorg(domain): add storage-independent domain kernel` | Adds branded identifiers, date/normalization/price/filter helpers, canonical entities, projections and repository interfaces under `src/domain/`, with focused tests.      |
| Export contract shield      | [`6c01c61`](https://github.com/prodigic/zivv/commit/6c01c612d7d31f2a601e3c3c1f1ea9218701cce5) — `test: add baseline data contract harness`             | Adds synthetic fixtures, dataset/delta checks, file metadata and reference validation. This was intended to guard later structural changes.                                |
| JSON repositories           | [`5143c61`](https://github.com/prodigic/zivv/commit/5143c61608c5a4a7fb8f608b30f3732d91b5a64b) — `feat: add JSON repository and query ports`            | Adds `JsonDatasetReader`, artist/event/venue/query repositories, legacy mapping and browser-cache interfaces under `src/data/`.                                            |
| ETL stages                  | [`30eac91`](https://github.com/prodigic/zivv/commit/30eac91d4c4cc65e29caa457b9a0fdcd67ddc570) — `refactor: separate ETL ingestion boundaries`          | Extracts source reading, normalization models, identity keys, projection derivation, export interfaces and pipeline orchestration from the broad processor.                |
| Worker/cache separation     | [`1b0ecaa`](https://github.com/prodigic/zivv/commit/1b0ecaaf913938546635df992280ea4baa58b0ed) — `refactor: separate worker and cache boundaries`       | Keeps fetching/cache/version decisions in the dataset reader, local persistence in a cache adapter, and CPU work in a worker processor with a main-thread fallback.        |
| UI query integration        | [`75abd4f`](https://github.com/prodigic/zivv/commit/75abd4ff0f76e2450edef06c660453f9dc1d4030) — `feat: integrate UI search with query repository`      | Routes store/page query paths through the repository boundary. This changes application data ownership and is not merely an unused interface extraction.                   |
| Build-store proposal        | [`79e6d4a`](https://github.com/prodigic/zivv/commit/79e6d4a523743a2fea8c1e3c3a1b0fd738d04caf) — `feat: add DuckDB build-store boundary`                | Adds schema, staging/canonical/projection/export interfaces, tests, a runtime capability probe and a deterministic in-memory implementation under `src/lib/store/duckdb/`. |
| Privacy boundary            | [`1cc68d0`](https://github.com/prodigic/zivv/commit/1cc68d0985485a7b5778b474fe7d1779ccc16b80) — `privacy: enforce anti-surveillance browser boundary`  | Adds a same-origin GET/HEAD request policy, local-only error handling and product/privacy documentation; limits transmitting query/history/user state.                     |
| Mobile-cache fix            | [`41c7e24`](https://github.com/prodigic/zivv/commit/41c7e246288e84bed128db9f978ef4e2bc467f6d) — `Fix stale mobile data cache versioning`               | Passes `manifest.datasetVersion` into artist, venue, index and event-chunk cache reads and updates tests. The same cache-version behavior already exists in current main.  |

The branch also contains merge commits combining these component workstreams,
lint/type repairs and a Storybook filter-provider fix. Historical successful
tests do not establish compatibility with today's application.

## What the DuckDB work does and does not establish

The branch's
[ADR 0001](https://github.com/prodigic/zivv/blob/41c7e246288e84bed128db9f978ef4e2bc467f6d/docs/adr/0001-duckdb-build-time-canonical-store.md)
calls DuckDB the proposed canonical normalized build store. That decision was
accepted inside the experiment; it is not an ADR adopted by current main.

`detectDuckDbNodeApi()` only checks whether `@duckdb/node-api` can be resolved.
`DeterministicMemoryBuildStore` supplies the actual fallback semantics. The
branch therefore establishes an interface/schema proposal and an in-memory
contract implementation, not a completed native DuckDB migration. Native
execution, dependency support, schema migration and production equivalence
still require review. Browser DuckDB-Wasm is explicitly deferred.

## Comparison with current main

| Concern                      | Current state and review implication                                                                                                                                                                                                                                                                                     |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Authoritative ingestion data | Main now has a shared SQLite ledger, transactional writers, receipts, redirects, immutable first-added history, encrypted recovery and a regression guard. An older build-store proposal must preserve and integrate these guarantees. It must not replace the authoritative store with an old snapshot or memory model. |
| Public export integrity      | Current ETL calculates checked file sizes/checksums and exports static JSON from the shared ledger with reviewed overlays. The August manifest defects are not presumed current; measure any remaining gaps before porting a fix.                                                                                        |
| Mobile cache versions        | Current `DataService` already passes the manifest version to entity/index/chunk cache reads and refreshes manifests. Assess remaining useful tests separately; do not treat PR #3's title as proof that its whole branch is needed for this fix.                                                                         |
| Reviewed metadata            | Current main adds exact-identity venue details/maps, show artwork, artist links/reviews and a Bandcamp pilot before derived summaries. Any extracted pipeline or repository must carry these fields and stale-identity guards correctly.                                                                                 |
| Browser data architecture    | The proposed `src/domain/`, `src/data/` and build-store modules are not present in current main. Their ownership/query ideas remain candidates for selective adoption, subject to actual loading, ordering, search and memory checks.                                                                                    |
| Network/privacy policy       | Main now uses external map tiles, artwork/media URLs, venue/music links and an opt-in Bandcamp iframe. Reconcile the old request policy with those explicit product integrations; assess privacy behavior and claims, not only a source-code merge.                                                                      |
| Friday delivery              | The scheduler, source acquisition, replay-safe orchestration, enrichment queue, publication/verification and monitoring are individually tracked under [#38](https://github.com/prodigic/zivv/issues/38). A new database engine is not an established prerequisite for that goal.                                        |

## Architecture review deliverables

1. Compare each component against current main and classify it as already
   covered, retain, adapt, defer or retire, with an evidence-backed reason.
2. Decide whether domain/repository interfaces improve concrete query ownership
   and completeness enough to justify the migration; identify measurable cases.
3. Decide the relationship between SQLite and any proposed DuckDB role. Possible
   roles must be evaluated before changing the current source of truth.
4. Preserve static deployment, canonical IDs/slugs, source observations,
   first-added dates, redirects, weekly membership, recovery and metadata guards.
5. Evaluate cold-start chunk loading, search, filters, ordering/pagination,
   cache invalidation, worker failures and mobile performance against current
   behavior using representative fixtures and full export comparison.
6. Review privacy/network implications and historical source snapshots before
   copying those files or reintroducing older public-source artifacts.
7. Produce a recommended order and small implementation issues for approved
   parts. Treat this as a review task; it does not authorize merging PR #3,
   replacing SQLite or implementing the whole refactor.

## Preserved source documents

- [Original assessment](https://github.com/prodigic/zivv/blob/41c7e246288e84bed128db9f978ef4e2bc467f6d/docs/repo-state-and-architecture-reorg.md).
- [Parallel-agent reorganization plan](https://github.com/prodigic/zivv/blob/41c7e246288e84bed128db9f978ef4e2bc467f6d/docs/reorg-parallel-agent-plan.md).
- [Worker/cache boundaries](https://github.com/prodigic/zivv/blob/41c7e246288e84bed128db9f978ef4e2bc467f6d/docs/worker-cache-boundary.md).
- [Privacy proposal](https://github.com/prodigic/zivv/blob/41c7e246288e84bed128db9f978ef4e2bc467f6d/docs/privacy.md).
- Current [shared-ledger contract](../shared-ledger.md),
  [weekly editions](../weekly-editions.md) and
  [metadata consolidation](../research/metadata-consolidation-2026-10-13.md).

## Separate disposition of f063

The user requested removal of the older `f063` import workspace. Its committed
head `71c3680` already belongs to main's history. The September 4 uncommitted
import/data output and untracked `work/zivv-architecture-site` are distinct from
the `1aeb` refactor. They are retained in a private recovery backup during
worktree removal and are not imported into main by this document. The `1aeb`
workspace and branch remain available for architecture review.
