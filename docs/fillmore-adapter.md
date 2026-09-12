# Fillmore venue adapter

The Fillmore adapter uses the documented [Ticketmaster Discovery API](https://developer.ticketmaster.com/products-and-docs/apis/discovery-api/v2/)
for primary discovery. The verified Discovery venue ID is `KovZpZAE6eeA` and the
adapter sends it as the `venueId` filter to
`https://app.ticketmaster.com/discovery/v2/events.json`. The API key is supplied
at run time through `VenueFetchContext.ticketmasterApiKey`; the adapter does not
write it to listings, warnings, inventories, or logs. The shared venue fetcher
removes secret query parameters from cache keys and observations.

Each request uses a page size of 200 and a maximum of five pages. The adapter
requires numeric `page.number`, `page.totalElements`, and `page.totalPages`
metadata, verifies that totals do not change, rejects an unexpected page number,
detects repeated page contents, and only reports complete after the unique,
verified venue event IDs equal `totalElements` at the declared final page. The
five-page bound keeps requests inside the documented deep-paging limit for a
200-item page size. Missing metadata, HTTP/JSON failures, duplicate pages, a
changed total, an unverified venue, or an early page end leaves `complete` false.

The API request's `startDateTime` is local today at Los Angeles midnight. The
adapter reports that same local date as `coverageStart`, even when the first
returned performance is later, so the reverse database check still covers
earlier same-day gaps. The HTML-only path uses local today as its lower bound as
well and reports its last observed valid listing date as `coverageEnd`.

The official `/shows` response is fetched as an audit. Its initial structured
markup is parsed from `application/ld+json` `MusicEvent` records and kept in a
separate incomplete inventory. The investigation observed 36 initial JSON-LD
records versus 58 rendered ticket listings, so this markup is never presented as
a complete fallback. Without an API key, the adapter returns the deterministic
initial-HTML candidates with `complete: false` and an explicit warning. The
adapter does not use private framework payloads or a browser automation fallback.

Ticketmaster attraction names and JSON-LD performer names are the only artist
evidence accepted. A listing without explicit performer markup remains a
`review` candidate with no fabricated artist name. A package/pass remains one
`package` listing, carries its date range in `session` when available, and is not
expanded into midnight or per-day performances. Non-music Ticketmaster
classifications are retained as `non-music` candidates for downstream review.

The first result inventory, `primary-discovery`, contains every returned listing
key, including `package`, `review`, and `non-music` candidates. When a key is
available, the primary and API inventories are required for coverage; the
initial-HTML inventory is marked auxiliary because its known partiality is
already accounted for. A missing or mismatched key discovered by that audit
still makes the adapter incomplete. The source registry remains disabled until
API parity and rendered-calendar coverage are reconciled in a later ETL
integration task. Full runtime access therefore requires a Ticketmaster API key;
the browser fallback remains outside this adapter's bounded scope.
