# Additional San Francisco venue sources

Investigated 2026-09-07 by the coordinating agent. These four groups supplement the three Luna/high investigations. This is source discovery, not a complete event census. Records are in [the JSON shard](../../data/research/sf-additional-venues.json).

## Brick & Mortar Music Hall

Existing ID **1719765223**, `the Brick and Mortar`. The [official contact page](https://www.brickandmortarmusic.com/contact/) verifies **1710 Mission Street, San Francisco, CA 94103**. The [calendar](https://www.brickandmortarmusic.com/calendar/) exposes dated cards, supporting acts, doors/show times, ages, prices, TicketWeb links and numbered pages 1–3. [Page two](https://www.brickandmortarmusic.com/page/2/) was reachable; all-page parity was not counted. A [representative detail](https://www.brickandmortarmusic.com/tm-event/cuva-bimo/) is available on the venue host.

Proposed adapter: ordinary HTML pagination, canonical detail/TicketWeb event identity, and changed-detail enrichment. Keep separate BIIRD nights; preserve sold-out and presale states. A sold-out Phora card displays $0.00, so that value cannot safely mean a free show. Dates beneath the sidebar's announcements are performance dates, not evidence of announcement timestamps. Do not use that sidebar as the full inventory or date-added ledger. No feed or cache validator was established.

## Public Works SF

Existing ID **755151683**, `Public Works`. The [official music-venue calendar](https://publicsf.com/calendar/) verifies **161 Erie Street, San Francisco, CA 94103** and provides month-grouped titles and Tixr links, with listings into December in the observed response. Use this domain; the similarly named municipal department is unrelated.

A [representative Tixr detail](https://www.tixr.com/groups/publicsf/events/fatima-hajji-presented-by-public-works-193237) exposes event ID **193237**, Main Room, 21+, lineup and 9pm–2:30am timing. Proposed adapter: HTML calendar discovery plus changed Tixr-detail enrichment; retain room, event kind and local overnight end date. Multiple cards can share a date. DJ sets, concerts, storytelling, art and yoga coexist, so apply explicit scope rules. Membership prices are not event admission prices. Full horizon/exhaustion and provider-wide parity remain unverified.

## Music City Starfactory

Existing IDs **1386365370** (`Music City`) and **1051500561** (`Music City Starfactory`) are candidate related records, not an approved merge. The [official homepage](https://musiccitysf.com/) identifies the current branding and **1355 Bush Street, San Francisco, CA 94109**. Its full-calendar link points to [Eventbrite organizer 12803819712](https://www.eventbrite.com/o/music-city-san-francisco-12803819712), which returned HTTP 429 during this investigation.

The homepage mixes performances, recurring programming, education, studios, streaming and hotel content. Proposed adapter: organizer events filtered to the verified SF address and specific room, with Eventbrite event IDs and dated occurrences. The linked organizer ID is verified as a destination, but its inventory, fields and pagination are unverified. Preserve the rate-limit failure as partial coverage; retry with backoff later. Do not generate occurrences from the recurring homepage description or infer a fixed room count from inconsistent marketing copy.

## Thee Parkside

Existing ID **485759302**, `Parkside`. The [official homepage](https://www.theeparkside.com/) verifies **1600 17th Street, San Francisco, CA 94107** and displays **“LAST DAY JULY 5th”**, without a year in the extracted banner. The page retains hours and photos, but no active show calendar was established.

Record the verified homepage and hold automated onboarding pending operating-status/calendar confirmation. A surviving homepage is insufficient proof of current programming, and no readable calendar is not proof of zero shows. Do not invent a calendar endpoint, manufacture a closure date, or delete historical events.
