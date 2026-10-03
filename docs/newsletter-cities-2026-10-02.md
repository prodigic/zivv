# Newsletter cities and Geographer

Geographer now has a verified local classification, confirmed by the user and
supported by the [artist-owned Bandcamp profile](https://geographer.bandcamp.com/)
and [label biography](https://www.tricyclerecords.com/artist/geographer/).

Bay Area, SF & Nearby, East Bay, and South Bay newsletters include the venue city
in local acts, recently added shows, and all shows. Preview, raw Markdown, and
copy use the same text. Missing locations and legacy street-number city fields
display `City TBA`.

The rendered check exposed legacy multiword cities stored as fragments. The
reviewed venue correction registry restores 53 full city names without changing
venue or event IDs. Forty-nine corrections use unambiguous locations recorded in
the private music-list source. Danny Murray's San Leandro location is supported
by [the performing band's calendar](https://face-kicker.com/shows); SAP Center's
San Jose location is supported by [the venue](https://www.sapcenter.com/contact-us).
Typographical city labels were checked against the official
[Cow Palace](https://www.cowpalace.com/) and
[Guild Theatre](https://www.guildtheatre.com/contact) location pages.
ETL applies these reviewed metadata corrections to venues, artist summaries,
and indexes. The shared ledger's events, original added dates, and frozen October
2 membership remain intact: 4,495 events and 177 weekly additions.

The encrypted ledger snapshot was refreshed and verified; its content was
unchanged, so identical ciphertext was retained. All 219 ingestion/component
tests passed. After adding city corrections, the 17 affected newsletter/export
tests passed again. Lint, locked-version formatting, TypeScript, and production
build passed. Browser checks include Geographer in the Rio Theater local bill
and full city labels across the regional newsletter sections.

Streetlight Records has a separate legacy ambiguity between Santa Cruz and San
Jose; Vets Hall combines Santa Cruz and Vacaville. They are tracked in
[issue #12](https://github.com/prodigic/zivv/issues/12) for audited event-level
reconciliation. Streetlight has no upcoming events on October 2. Vets Hall shows
`City TBA` until the individual locations are reconciled.

Requested work is tracked in [issue #11](https://github.com/prodigic/zivv/issues/11).

Live browser verification also exposed the browser's ten-minute HTTP cache
retaining a previous export even when new application code had loaded. Network
data requests now revalidate HTTP cache entries; IndexedDB continues to reuse
entities for the matching dataset version. A regression simulates an HTTP cache
and verifies that a newly published manifest reloads corrected city metadata.
The test failed with the previous behavior and passed after the fix. The export
was refreshed to invalidate any previously cached mixture of versions.
