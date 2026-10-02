# Death From Above 1979 listing correction

Verified October 1, 2026 against the [UC Theatre event page](https://www.theuctheatre.org/shows/death-from-above-1979-02-oct).

The retained October 2 source has both `Death From Above, 1979` and `Death From Above 1979, Rickshaw Billie's Burger Patrol`. The first row split the band name into a headliner and a phantom supporting artist. Both bills describe the same UC Theatre performance. The venue now explicitly says it moved to August Hall on February 11, 2027, and that previously purchased tickets remain valid.

The catalog already has the February 11 August Hall destination. The repair uses that listing's date, venue, time, price, age restriction, and billing. It keeps the earliest listing's ID **1992667217**, original slug, and May 8 date added. Listings **1378399671** and **190538854** become ledger redirects. Every source observation remains attached; the audit retains the original records. The old UC supporting act is not inferred to be on the new bill.

The malformed legacy record also has a corrupt stored start time. The repair checks retained raw billing evidence for that specific record; differing modern sessions still require review. Other dates, venues, and standalone artists named `1979` stay unchanged.

`data/line-corrections.json` maps only the stale October 2 UC Theatre bills to the existing February listing, preventing their reappearance on import. `data/event-slug-redirects.json` keeps the two retired public links working through the generated indexes. Event details load the surviving event's current month.

## Operator procedure

Run in the checkout containing the private ingestion ledger:

```powershell
node node_modules/typescript/bin/tsc --project tsconfig.build.json --pretty false
node scripts/repair-death-from-above.js
node scripts/repair-death-from-above.js --apply
node scripts/run-etl.js
```

The default repair command is read only. Applying it writes `data/ingestion/reports/death-from-above-repair.json` before saving the ledger. A repeated repair makes no changes. Review the generated February event, the weekly UC Theatre card, and all three original event links before release.
