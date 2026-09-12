# Ingestion migration and local operations

Implemented locally September 7, 2026 on `codex/daily-venue-import-plan`.
The durable catalog and date-added discovery foundation are ready for local
review. Live venue fetching, completeness auditing, daily scheduling, and
publication remain separate work. Every researched crawler remains disabled.

The deployment branch contains the generated public dataset, but intentionally
does not contain the raw Steve's List input, the full ingestion ledger, or
review reports. Those files stay in the private operator checkout used for
daily imports. The GitHub ETL workflow detects the missing private ledger and
leaves the checked-in static export unchanged; import and weekly-edition
commands must therefore run from that private checkout before publishing a
new generated dataset.

## What changed

`data/ingestion/ledger.json` is the canonical build-time store. `public/data`
is a disposable static export; the browser still reads anonymous static JSON.
This is a versioned JSON ledger migration, with no hosted database or DuckDB
dependency. Ordinary parsing, matching, validation, and exports use no AI tokens.

The one-time migration copies the exact previous generated catalog: 3,909
events, 7,251 artists, and 624 venues. All prior events are explicitly attributed
to Steve's List, as confirmed by the owner. Existing event IDs and known added
timestamps are preserved. Historical dates are labeled `legacy-batch`, rather
than pretending they are exact observation times. Missing historical dates
would be marked `unknown` and excluded from date-based additions; this snapshot
has none. `data/ingestion/migration.json` records the baseline and checksum.

New accepted events receive `createdAtEpochMs` once, the observed import time,
with `addedDateProvenance: observed`. `firstImportedBy` is immutable. `sources`
retains both Steve's List and venue observations when they refer to the same
show. Source IDs, URLs, provider event IDs, and sessions aid reconciliation.
Source-linked updates preserve identity and added date; uncertain matches go
to a review report. Legacy clock values remain explicitly labeled; new show
times are real instants in the venue timezone.

The Just Added page filters by Los Angeles calendar date range, original
importer, and contributing source. It uses a compact additions index to load
the necessary event months. Shared badges and added-date labels use the same
date semantics. Dataset versions invalidate cached event and entity data.

Weekly editions freeze a half-open added-date window and event IDs. A Tuesday
venue import remains eligible in Friday's edition even after Steve's List
references the same show. Preparing/retrying a draft does not advance the
published cutoff. See [weekly editions](weekly-editions.md).

## Commands

Compile before running the Node CLIs:

```text
npm run build:etl
node scripts/migrate-ingestion.js
node scripts/import-events.js steveslist --file data/latest.txt --dry-run
node scripts/import-events.js steveslist --file data/latest.txt
node scripts/run-etl.js
```

Migration is already applied to this branch. Repeating it validates the ledger
and makes no changes. ETL requires a valid ledger and never reparses historical
text to manufacture new events. The existing validate/merge/ETL workflow also
routes incoming Steve's List content through this reconciler before archiving
text. Editing `data/events.txt` alone no longer changes the canonical catalog.

The existing August 21 `latest.txt` is now recorded in
`data/ingestion/historical-batches.json`, verified against import commit
`71c3680` and the exact migration baseline. Retrying that file is a no-op,
including through the newer strict parser. It does not manufacture a new run,
invent per-row acceptance history, or change the ledger. A different file is
validated normally. The five malformed rows observed in that historical file
do not mean the original import failed or needs repeating.

The registration command for an operator-selected baseline commit is
`node scripts/register-historical-batch.js --commit SHA`. It verifies the
committed source content, dataset version, event identities, and preserved
added dates before writing a receipt. It rejects a current file that differs
from the chosen commit. Parser/configuration changes never make the unchanged
historical source appear newly imported.

An explicit, normalized venue batch can be reviewed and imported:

```text
node scripts/import-events.js venue --file path/to/batch.json --dry-run
node scripts/import-events.js venue --file path/to/batch.json
node scripts/run-etl.js
```

The batch shape is `IngestionBatch` in `src/types/ingestion.ts`. It requires a
registered `sourceId`, `origin: zivv-venue-import`, unique `runId`, observation
timestamp, candidate events, and their referenced artists and venues. Provider
IDs, canonical URLs, and session labels belong on candidate wrappers. Venue
IDs must match the source's registered canonical venue; resolve room mappings
before importing. Supplied start times require `timeBasis: instant`.
This command consumes a prepared JSON batch; it does not fetch a website.

Replaying identical input preserves the ledger. Reusing a run ID with changed
content fails. Review reports and unresolved candidate evidence are retained
under `data/ingestion/reports`; review items are not silently accepted. To
resubmit a corrected candidate use a new run ID. An absent listing never causes
automatic deletion or cancellation.

Prepare a weekly edition after imports, then export and review:

```text
node scripts/weekly-edition.js prepare --id 2026-09-11 --cutoff 2026-09-11T19:00:00.000Z
node scripts/run-etl.js
```

After the reviewed edition has actually been published, record success:

```text
node scripts/weekly-edition.js mark-published --id 2026-09-11
```

That command only advances local weekly state; it does not send a newsletter or
deploy the site. No real edition was prepared or marked published during this
migration.

## Validation and recovery

The focused suite covers migration preservation, cold export, exact file sizes
and SHA-256 checksums, duplicate/replay handling, source links, session identity,
date ranges and daylight saving, weekly retries and missed runs, and cache
version rejection. Run it with `npm run test:ingestion`. Check both ETL and app
TypeScript configurations and build the production site before release.

The local migration was checked against the previous committed snapshot:
all 3,909 IDs and added dates are unchanged. Generated summaries carry origin
and date precision. Local validation uses the available shared dependency
installation; it is not evidence of a fresh lockfile install in CI.

Local verification: 87 tests across 13 files passed, including the existing
event/venue parser regressions. ETL and application type checks and the
production build passed. The browser showed 103 upcoming events added August
21, then zero when restricted to Zivv-origin imports, matching this historical
Steve's List catalog. The current-week filter and newsletter showed zero new
additions; migration did not relabel old events as new.

All import, migration, weekly, and export writers share
`data/ingestion/.writer.lock`. A second writer fails instead of racing. If a
process crashes, inspect the recorded PID and confirm it is no longer running
before removing its stale lock. Ledger writes use an atomic file replacement.
ETL validates before replacing `public/data` and retains the previous complete
directory under `.cache/etl-backup-*` for recovery.

Commit and back up `data/ingestion` with source changes. Restore the ledger,
weekly state, reports, and compatible code together from a known good commit
before re-exporting. A missing/corrupt ledger fails closed. A schema-2 public
export is deliberately rejected as a historical bootstrap source. To undo the
migration itself, restore pre-migration code and data together; do not delete
the ledger while continuing to use the migrated exporter.

## Remaining work

- The [three-venue pilot](venue-pilot.md) implements deterministic adapters,
  bounded conditional fetches, pagination and source/DB coverage reports for
  Bottom of the Hill, Rickshaw Stop and The Fillmore. Resolve pilot identity
  reviews and verify Fillmore's API path live before accepting batches.
- Extend adapters and website joins to the remaining researched SF venues;
  resolve remaining venue aliases/rooms before onboarding their imports.
- Add daily scheduling and explicit publication integration after pilot gates.
- Add a bounded extraction fallback only where deterministic adapters fail.

These follow-ups map to VI-3 through VI-7 in the
[daily import plan](daily-venue-import-plan.md). Beads CLI is unavailable in this
environment, so the remaining work is tracked in that repository plan.
