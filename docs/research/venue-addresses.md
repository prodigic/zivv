# Venue street and web address research

Research date: October 2, 2026. Three GPT-6.1 Sol agents with medium reasoning
review the 651 venue IDs in the authoritative shared ledger. The assignments
are in `data/research/venue-addresses/inventory-{1,2,3}.json`; evidence and notes
are in the corresponding `results-{1,2,3}.json` and research reports.

The catalog contains typo aliases, separate rooms, historical businesses,
festivals, private spaces, and venue names shared by multiple locations. Each
record retains its original ID and name. An address correction is not an alias
merge or an event reassignment. Conflicting identities retain their prior
metadata until the conflict can be resolved from event-specific evidence.

The consolidated `data/venue-details.json` registry records the street address,
city, official website, sources, verification date, and explanatory notes for
each researched record. `verified` means both address and website were found;
`partial` records contain fields supported by indexed official pages, organizer evidence, or explicitly cited retained event/venue listings; `unresolved`
records document an identity conflict or unavailable evidence. Null fields do
not erase existing metadata. Historical addresses remain historical, and park
or street events use official access locations rather than invented numbers.

## Apply and verify

Read `docs/shared-ledger.md` first and use Node 24.19.0 or newer.

```text
npm run build:etl
npm run ledger:status
node scripts/enrich-venue-details.js
node scripts/enrich-venue-details.js --apply
npm run etl
node scripts/verify-venue-details.js
npm run ledger:verify
```

The first enrichment command reports proposed changes without writing the
ledger. `--apply` checks every registry ID and exact venue name before updating
address, city, and website in one shared-store transaction. Only changed venues
receive an updated timestamp. Event IDs, event dates, billing, source history,
and first-added timestamps remain intact. The transaction refreshes the
encrypted recovery snapshot before and after the operation.

ETL reapplies the reviewed metadata before building summaries, city indexes,
and static browser JSON. This preserves the researched details when older
snapshots or future imports contain incomplete venue metadata. The encrypted
snapshot must accompany the generated export when published.

The automated checks cover same-name rooms, unchanged IDs and timestamps,
repeatability, incomplete metadata, unresolved identities, identity mismatch,
duplicate registry IDs, unsafe URLs, and export propagation into artist
summaries and city indexes. Source review remains a human/research task;
syntactic validation alone does not verify a venue's identity.

## Coverage and unresolved findings

All 651 records were researched. 476 have both fields verified, 143 have partial evidence, and 32 retain unresolved identities or unavailable evidence. There are 602 researched street addresses and 526 researched web addresses. No research placeholders remain.

The [complete catalog](venue-address-catalog.md) lists every venue, field, source and limitation. The [independent review](venue-addresses-review.md) caught cross-city Streetlight and Civic Center records, distinguished Blue Note Summer Sessions from the closed downtown club, retained separate Mabuhay rooms, and selected the clean Bottom of the Hill calendar URL. All five review findings were addressed before applying the registry.

Unresolved records include parser fragments, private undisclosed locations and conflicting branches. These require source clarification or a separate event-to-location repair; metadata enrichment does not merge or reassign their events. Partial addresses taken from the original listings are not independent owner confirmations. These sources use the explicit citations `data/events.txt` or `data/venues.txt`; a record supported only by retained input cannot be marked verified.

## Final verification and delivery

Applied supported metadata to 613 distinct venues in the authoritative store;
the two municipal park website replacements were then corrected within that
same set. A second dry run reports zero remaining changes. The final ledger
revision is `0c1b7fe0223c6772574d9cce04d9a5c83c7feed71566dbb621707767225ac53d`.
Encrypted snapshot decryption, temporary SQLite restoration, integrity and
foreign-key checks pass. Public export coverage is exactly 651 researched IDs.

The before/after audit hashes the complete logical ledger after excluding only
venue address, city, website and update timestamp. The digest stayed
`5561bcf199b0e1fd0853818de73a3fa38de33c726f86f991ca58697e344761f6`.
All 4,495 events, 8,466 artists, 651 venues, five import runs and 283 redirects
retain their remaining data, including first-added dates and source history.
ETL still reports two pre-existing cross-year duplicate warnings; enrichment
does not alter those events.

All 232 tests across 31 ingestion/component test files pass with the checked-in
dependency lock versions. TypeScript, repository ESLint, the configured source
formatting check and the production Vite build pass. Windows recovery tests
were run with access to the operator's DPAPI-backed test key storage.

The direct URL check covered 436 unique candidate URLs, including earlier
replaced candidates. Some official sites reject automated requests or time out;
that alone does not establish closure. Removed municipal pages were replaced
with working current city pages. Complex's Wix domain error and 3 Disciples'
expired Squarespace site are retained only as explicitly historical partial
web addresses. The final catalog and registry include these checks; the shard
reports document subsequent corrections after their original tables.

The branch includes the complete source registry, catalog, generated browser
JSON and refreshed encrypted snapshot for review. It has not been published to
the live site. Beads CLI is unavailable in this environment; issue status and
remaining evidence work are recorded directly in the tracked JSONL issue file.
