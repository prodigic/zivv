# Venue OpenStreetMap tiles

Each of the 651 existing venue identities has a researched map record in
`data/venue-maps.json` and a row in the [tile catalog](venue-map-catalog.md).
The catalog includes coordinates, precision, an OpenStreetMap viewing link,
the corresponding Slippy tile URL, source evidence and remaining limitations.
Several venues can share one map tile; their marker pixels differ.

The application shows a small linked map preview on each venue detail page.
It requests one 256-pixel tile only when the preview is viewed, preserves normal
browser caching and Referer behavior, and displays visible OpenStreetMap
attribution. Image failure leaves a usable map link. Records without supported
coordinates offer a venue/address search instead of a fabricated location.

## Coordinate evidence

Numbered, city-qualified public addresses from the reviewed address registry
were deduplicated into 430 queries representing 548 venue IDs. One
[Census batch request](https://geocoding.geo.census.gov/geocoder/Geocoding_Services_API.html)
returned 382 exact address matches, 12 non-exact matches, 31 no-matches and five
ties. Ten non-exact matches had documented street-suffix, building or
direction differences at the same house number and city. The two others were
not accepted automatically. A different returned city/state also requires
manual review. Input, raw response and checksum-bearing receipt are retained
under `data/research/venue-maps/`; repeat runs reuse the cached response.

Census matches represent approximate interpolated street-address positions,
not building entrances. Published owner, government and open-data site points
supplement these for campuses, parks and unmatched addresses. Their individual
sources and scope are recorded in the registry and research reports.
Unresolved cross-city identities and undisclosed locations receive no pin.
Historical venues can map their documented historical location; a map does
not establish current operation.

`address` means approximate street-address point, `site` means published venue
site point, and `area` means a park, access intersection or festival area.
Outdoor access points do not claim to locate a specific stage. The preview
labels these distinctions. A reviewed null location clears a stale pin; an
absent optional registry preserves existing metadata. Identity and validation
checks run before any ledger mutation.

## Open source and service terms

The default URL template is
`https://tile.openstreetmap.org/{z}/{x}/{y}.png`. OpenStreetMap's standard style
is [OpenStreetMap Carto](https://github.com/gravitystorm/openstreetmap-carto).
Map data is available under [ODbL](https://www.openstreetmap.org/copyright),
and the preview visibly credits OpenStreetMap contributors. Any OpenStreetMap
coordinate observations retained here carry the same source attribution.
Census address observations are US government data.
The shared map-coordinate database is provided under ODbL; see the
[evidence license notes](../../data/research/venue-maps/README.md).

The public tile service has limited capacity. The implementation follows the
[OSMF tile policy](https://operations.osmfoundation.org/policies/tiles/): no
bulk/offline image downloads or prefetch, no cache-bypassing requests, normal
browser identification and visible attribution. The tile provider can be
changed with `VITE_MAP_TILE_URL`; any replacement must permit the use and
retain appropriate attribution. No live geocoder is built into the browser.
No public Nominatim API was used. Two small named-feature Overpass attempts
timed out; unsuccessful results were not treated as coordinate evidence.

## Build, apply and verify

Read [shared-ledger operations](../shared-ledger.md) first. With Node 24.19.0+:

```text
npm run build:etl
node scripts/geocode-venue-maps.js
node scripts/build-venue-maps.js
node scripts/enrich-venue-maps.js
node scripts/enrich-venue-maps.js --apply
npm run etl
node scripts/verify-venue-maps.js
npm run ledger:verify
```

Geocoding is an explicit operator step using cached public addresses; build,
ETL and browser views make no geocoding requests. The metadata repair updates
only the map location and the changed venue's update timestamp. It preserves
event data, venue identities, address research and first-added dates. ETL
reapplies the reviewed map registry before exporting static browser JSON.
The refreshed encrypted ledger snapshot accompanies the export.

## Final coverage and verification

All 651 identities have a catalog entry. 594 have a supported tile reference:
491 approximate address matches, 28 site points and 75 area estimates. The
remaining 57 have venue-specific OpenStreetMap searches and explicit reasons
for leaving coordinates unset. These include conflicting branches, private
locations, stale address metadata, unidentified performance spaces and
unresolved geocoder matches. A search link is not a verified map tile.

Applied map metadata to 594 distinct venues. The final ledger revision is
`c645ae7133175e70076c2e49ed41aa075c504d53bc65751f1c860d0b963ecfac`.
Full logical-ledger hashing after excluding only map location and changed
venue update timestamps yields the unchanged digest
`b2500ada8afd7dc654b2affb8bedab4f840705efd7edcfe17703a7a5084f5cb2`.
All event data, IDs, street/web address research, source history and first-added
dates are preserved. Map and address export verifiers pass; encrypted backup
decryption, temporary restoration and SQLite integrity checks pass.

The 271 regression tests include registry identity/atomicity, stale-pin
clearing, Mercator boundary math, marker positions, export preservation,
attribution overlay placement and image-failure navigation. TypeScript,
repository ESLint, source formatting and production build checks pass.
The production preview was checked in the in-app browser: the image and
marker render, credits remain on the visible tile, and an unresolved venue
retains usable search navigation. No bulk tile requests or image archives
were created. The shared ledger and review branch are updated; the live site
has not been published.
