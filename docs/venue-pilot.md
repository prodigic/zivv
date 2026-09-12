# Three-venue import and coverage pilot

The pilot fetches Bottom of the Hill, Rickshaw Stop, and The Fillmore, classifies
every discovered listing, and compares it with the canonical Zivv ledger. It
runs explicitly in shadow mode. It does not schedule work, publish the site,
change existing events, or automatically cancel shows missing from a calendar.

## Run it

```text
npm run build:etl
node scripts/venue-pilot.js
node scripts/venue-pilot.js --source bottom-of-the-hill-sf
node scripts/venue-pilot.js --source rickshaw-stop-sf
node scripts/venue-pilot.js --source fillmore-sf
```

`--strict` returns a failing exit status when any selected source is not ready
for import. `--offline` replays cached responses for parser review; it always
marks current source completeness unverified. `--root PATH` supports isolated
review/test directories. A `TICKETMASTER_API_KEY` environment variable enables
The Fillmore's documented Ticketmaster Discovery API path. Keep it out of source
control. The fetch cache and reports remove API credentials from URLs and echoed
response links.

Output is saved under `.cache/venue-pilot/<run>/`. `report.json` contains the
summary and full per-venue accounting. Source snapshots and reconciliation
reports are separate files. An import-ready `.batch.json` is produced only when
the source is complete and no candidate needs review; it can then be passed to
the existing structured venue importer. Partial results remain review evidence.
Review these files before using the importer; this pilot has not inserted shows.

## What the report means

- **Source complete/partial/failed** describes extraction within the observed
  calendar horizon. It cannot establish events beyond that horizon or events
  never published by the venue. Empty pages, missing pagination, unaccounted
  source keys, and conflicting occurrences cannot count as complete.
- **Matched** means the shared reconciler identifies an existing canonical
  event. Its ID, slug, original importer, and date added remain stable.
- **Missing from DB** means a valid candidate has no confident canonical match.
  It is an addition candidate, not proof the venue announced it recently.
- **Review** covers uncertain performers, ambiguous source identity, and legacy
  time/lineup discrepancies. It is not silently added or merged.
- **Excluded** retains a reason for ticket packages, non-music programming, and
  past listings. A pass is not turned into an extra concert.
- **DB events not on source** is the reverse comparison for the stated horizon.
  It flags potential omissions, cancellations, venue moves, or duplicate/alias
  records for review. It never deletes or cancels a canonical event.

Auxiliary inventories are compared separately. In particular, an RSS omission
must not hide a Bottom of the Hill calendar show. If a source fetch is partial,
the report says the DB is **not verified**, even when the parsed subset matches.

## Cost and resilience

Routine execution makes **zero model calls**. The adapters parse HTML/structured
data deterministically using the existing build-time jsdom dependency. The
browser application never imports these modules. No poster assets are fetched.

The shared HTTP client uses conditional ETag/Last-Modified requests, validates
cached text hashes, honors declared character encodings, serializes requests,
and bounds per-source requests, response bytes, redirects, and timeouts. Cache
state lives under `.cache/venue-fetch`; failed HTTP responses do not replace a
good cached body. Source-host allowlists constrain redirects. Cached failures
are never passed off as a successful live audit. Prior pilot reports remain
available when a later run fails.

The three verified website URLs are also joined into generated venue records
during ETL. Other researched venue mappings remain unchanged. Source scheduling
flags remain disabled while this manual pilot is reviewed.

## Adapter details and next step

See [Bottom of the Hill](bottom-adapter.md), [Rickshaw Stop](rickshaw-adapter.md),
and [The Fillmore](fillmore-adapter.md) for selectors, fixtures, pagination, and
source-specific limitations.

The daily scheduler and publication workflow are subsequent work. Resolve
identity reviews and source completeness limitations before enabling sources.

## Local validation, September 8, 2026

The existing `latest.txt` is now registered against historical import commit
`71c3680c465b0d812f91bd21b62005bc66a078c1`. Its exact normalized content replays
as an already processed Steve's List batch. Replay also checks the migrated
baseline population's IDs, dates added and original importer, without changing
the ledger or giving old events a new date. Changed source content still goes
through strict parsing and reconciliation.

The static export retains all 3,909 historical IDs and dates added, and its 19
manifest-listed file sizes/checksums were verified against the actual bytes.
The ledger remains byte-for-byte identical to the pre-pilot commit. The three
pilot website URLs now appear in `public/data/venues.json`.

An earlier Bottom of the Hill repeat audit fetched both calendar and RSS using
304 responses: zero response-body bytes downloaded. The calendar remains the
baseline and retains the October 8 show absent from RSS. A current RSS-only
listing would instead require review before claiming source completeness.

Final combined live audit: `2026-09-08T09:28:57.790Z`, ledger revision `1`,
zero model calls. Full local evidence:
`.cache/venue-pilot/2026-09-08T09-28-57-790Z-a89d7737/report.json`.

| Venue | Source coverage | Listings | Matched | Likely additions | Review | Excluded |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| Bottom of the Hill | Complete, Sep 8-Dec 12 | 66 | 7 | 14 | 44 | 1 |
| Rickshaw Stop | Partial, Sep 8-Apr 6 | 62 | 0 | 14 | 47 | 1 |
| Fillmore | Partial, Sep 8-Nov 15 | 36 | 0 | 0 | 36 | 0 |

Bottom's review records have same-day lineup/time ambiguities against legacy
events; five additional DB events were not found on its source within the stated
horizon. Rickshaw's seven list pages account for all 61 calendar occurrences,
plus one undated, rosterless `SOLD OUT - Thank You!` card (provider ID `544202`).
That extra card is retained for review and keeps the list inventory partial.
Its reverse comparison also identifies eight DB records requiring investigation;
partial source coverage prevents interpreting them as confirmed omissions.

The final run used ten requests and 1,144,989 response-body bytes. Bottom's RSS
returned 304; its calendar returned a fresh body. These byte counts are decoded
response-body sizes, not compressed wire traffic. No per-show pages or images
were needed for this run.

No Ticketmaster API key is configured in this workspace. Fillmore's 36 initial
JSON-LD records remain partial and require performer review. Fixture tests cover
API pagination, venue matching, count limits and an auxiliary HTML subset; the
full API route still needs live validation with a configured key.

Validation: 132 tests across 20 files pass, including existing parsers, ledger
replay, weekly discovery and UI regressions. Both TypeScript configurations,
lint for changed production code, and the production Vite build pass. Test files
are excluded by the repository's ESLint configuration. Validation used the
existing shared dependency installation rather than a fresh CI install.

These are discovery and reconciliation audits. No fetched show was inserted,
no weekly edition was prepared, and no source schedule was enabled.
