# Weekly editions

Weekly additions are durable snapshots of the canonical ingestion ledger. The
snapshot is prepared before ETL export and is published only by an explicit
`mark-published` command. Preparing an edition never advances the published
cutoff, sends mail, or writes a file under `public/data`.

The state file is `data/ingestion/weekly-editions.json`:

```json
{
  "schemaVersion": 1,
  "publishedCutoffEpochMs": null,
  "editions": [
    {
      "editionId": "2026-09-11",
      "startEpochMs": 1788562800000,
      "endEpochMs": 1789167600000,
      "eventIds": [123, 456],
      "datasetVersion": "ingestion-v42",
      "status": "draft"
    }
  ]
}
```

`publishedCutoffEpochMs` is `null` until an edition is explicitly marked
published. It always equals the end of the latest published edition. A new
edition starts at that cutoff. The first edition starts at Los Angeles local
midnight seven calendar days before the cutoff's Los Angeles date and ends at
the requested cutoff instant. Windows are half open: the start is included and
the cutoff is excluded. This uses `America/Los_Angeles`, so the range remains
calendar correct across daylight-saving changes.

`datasetVersion` records the canonical ingestion ledger revision used to select
the frozen membership, written as `ingestion-v<ledger.version>`. ETL assigns a
new top-level `manifest.datasetVersion` when it exports the static dataset; that
export version can therefore differ from the edition's source revision. The
edition's source revision remains immutable across retries.

An edition contains every canonical event whose known `createdAtEpochMs` is in
the frozen range. It does not filter by show date, so an event that has already
happened remains in the durable membership. Presentation code may group or
omit already-happened events for the selected city after loading the full
membership. Events with a missing timestamp or explicit `addedDateProvenance:
"unknown"` are excluded because their date added is not known. `observed` and
`legacy-batch` timestamps are eligible.

The pure API is exported from `src/lib/ingestion/weekly.ts` and includes:

- `parseWeeklyLedger` / `parseWeeklyEditionLedger` and
  `serializeWeeklyLedger` for validating the persisted shape;
- `prepareWeeklyEdition(ledger, events, options)`, which creates a `draft`;
- `markWeeklyEditionPublished(ledger, editionId)`, which advances the cutoff;
- `addedInWindow` and `selectEventIdsForWindow` for the shared half-open
  predicate;
- Los Angeles calendar helpers for initial windows and date boundaries.

Preparing an existing ID is an idempotent retry. The original membership,
window, dataset version, and status are returned even if the canonical event
ledger has changed. A different requested cutoff for that ID is rejected. A
new ID cannot skip an earlier draft, and publication must happen in draft
window order. Missed weeks are represented by one later window beginning at
the last successful cutoff, so additions are not silently skipped.

The CLI reads canonical events and their revision from the validated
`data/ingestion/ledger.json`:

```text
node scripts/weekly-edition.js prepare --id 2026-09-11 --cutoff 2026-09-11T19:00:00.000Z [--root <project-root>]
node scripts/weekly-edition.js mark-published --id 2026-09-11 [--root <project-root>]
```

The CLI uses the built canonical ledger module's `loadLedger(path)` validator
and serializes weekly writers with the shared ingestion writer lock. State
writes use a temporary file in the same directory, flush it, and rename it
into place. Existing malformed state fails closed and is never replaced by an
empty ledger. Migration fixtures using only `{"events":[...]}` belong in
tests; production preparation requires the validated canonical ledger.
