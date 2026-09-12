# Venue source investigation

Investigated September 7, 2026: The Fillmore, Rickshaw Stop, and Bottom of the
Hill. This is a source-onboarding investigation, not an enabled importer.

Implementation follow-up: the [three-venue pilot](venue-pilot.md) now provides
deterministic fetchers and coverage reports. The observations below are the
original September 7 investigation; current pilot results and limitations are
recorded in that handoff. Scheduling remains disabled.

Verified URLs and existing venue IDs are saved in
[`data/venue-sources.json`](../data/venue-sources.json). Entries are deliberately
`investigated` with `enabled: false`. At investigation time, no crawler consumed
this file and joining website values into public venue records remained an ETL
task (both are now implemented for the manual pilot). The original generated
JSON and live event data were not changed by this investigation.

## Findings that change the implementation plan

| Venue | Verified discovery surface | Observed inventory | Main implementation issue |
| --- | --- | --- | --- |
| [The Fillmore](https://www.thefillmore.com/shows) | First HTML response includes JSON-LD; list loads more records when scrolled | 36 initial records; 58 ticket listings after loading, including 3 multi-show packages | Initial structured markup misses 22 listings, even after the browser has loaded them. Prefer the documented Ticketmaster API, with venue-page reconciliation. |
| [Rickshaw Stop](https://rickshawstop.com/calendar/) | WordPress HTML contains both a paginated list and a full calendar | 10 initial list cards; 7 list pages; 61 calendar occurrences | Discover from the entire calendar; enrich from paginated list cards. Do not stop at the first 10 or at an empty month. |
| [Bottom of the Hill](https://www.bottomofthehill.com/calendar.html) | Detailed HTML calendar plus linked [RSS](https://www.bottomofthehill.com/RSS.xml) | 67 current/future detail URLs; RSS covers 66 of those | RSS alone misses one listing and contains multiple revisions of the same show. Calendar is the coverage baseline. |

All three primary pages responded to direct HTTP GET without authentication.
That establishes basic retrieval feasibility, not full inventory or field
completeness. Browser inspection exposed the Fillmore pagination gap and verified
the Rickshaw ticket detail that the direct HTTP client could not retrieve.

Counts are an observation of these sources, not a promise that every real-world
show is listed. The comparisons below use this worktree's August 22 generated
dataset, not the current production website or another worktree's newer imports.

## The Fillmore

Identity: Zivv `1136597428`, name `Fillmore`; official name The Fillmore, 1805
Geary Boulevard, San Francisco. Website: <https://www.thefillmore.com/>.
The official event markup identifies the venue as Ticketmaster Discovery
`KovZpZAE6eeA` through its Live Nation venue link. Preserve that provider ID
separately from Zivv's ID and each Ticketmaster event ID.

### Observed behavior

- `/shows` returned about 432 KB of decoded HTML with **36 actual MusicEvent
  JSON-LD script elements**. A string search counted 72 appearances because
  serialized framework data repeated the marker; count parsed records instead.
- Initial JSON-LD provides name, start date/time with UTC offset, ticket URL,
  scheduled status, and venue identity/address. The sample had no performer or
  offer fields. The first-party More Info dialog supplied a separate lineup.
- Scrolling loaded **58 distinct ticket URLs**, extending through May 6, 2027.
  JSON-LD still contained only the initial 36 events. A JSON-LD-only importer would
  silently omit 22 listings. The loading indicator disappeared after this batch;
  production termination still needs a bounded, explicit exhaustion check.
- The calendar has month navigation, for example
  [`/shows/calendar/2026-09`](https://www.thefillmore.com/shows/calendar/2026-09)
  linking to October. Direct retrieval of six linked months succeeded, but those
  responses had no event JSON-LD and required client rendering for visible calendar
  events. A successful month-page GET alone is not evidence of extracted shows.
- Three listings were multi-show ticket packages: My Morning Jacket, The Mountain
  Goats, and California Honeydrops. Individual performances also appeared.
  Package JSON-LD can have a placeholder `00:00:01` start time; do not turn a pass
  into another midnight concert or expand every day in its date range into a show.
- The sample HTTP response had neither ETag nor Last-Modified. Content hashing is
  still useful after fetching, but validator-based bandwidth savings were not
  established for this site.

### Recommended adapter

Use the documented [Ticketmaster Discovery API](https://developer.ticketmaster.com/products-and-docs/apis/discovery-api/v2/)
with the verified venue ID and pagination. It supports venue filtering, page
metadata, and event detail retrieval, and requires an API key. The API was **not
called with a key** in this investigation; its parity with all 58 public listings
is an implementation gate, not a verified result. Keep its key on the build runner.

If API access is unavailable, the observed fallback is deterministic browser
pagination plus DOM extraction, with event detail dialogs as necessary. Do not
depend on reverse-engineered framework payloads/private endpoints for the initial
production design. Browser operation can run without an AI model in the job.

Key on provider event ID, retaining its canonical ticket URL. Separate event
status from ticket availability. Match source titles to performer records rather
than treating a tour name as an artist. Classify passes as ticket products and
link to individual performances. Preserve unknown price/age values until sourced.

Coverage gate: reconcile API/list IDs across the full future horizon, account for
packages explicitly, and compare at least one later month with the rendered
calendar. List and calendar share an upstream provider, so agreement tests
extraction coverage, not an independent source of all shows. An empty intervening
month is not a stopping condition: a May listing was present after February.

## Rickshaw Stop

Identity: Zivv `31041890`, Rickshaw Stop, 155 Fell Street, San Francisco.
Website: <https://rickshawstop.com/>; calendar:
<https://rickshawstop.com/calendar/>.

### Observed behavior

- About 237 KB of calendar HTML contains **61 event containers across 12 month
  grids**, September 2026 through August 2027. Observed event counts by month:
  September 18, October 22, November 11, December 8, February 1, April 1. Empty
  January/March grids do not mean there are no later shows.
- The same response contains **10 detailed list cards** and numbered controls for
  pages 1–7. Calendar and list are two presentations of overlapping events; they
  must not produce duplicate imports. The list pagination uses page data attributes;
  its full seven-page enrichment flow still needs implementation and verification.
- Calendar blocks expose title, month/day/year context, show time, doors time,
  ticket URL, and sometimes supporting talent. List cards add separate headliners,
  support, venue, age restriction, price, and genre. No JSON-LD was found.
- Useful selectors are `.seetickets-calendar-event-container`, the enclosing
  month header and day cell, `.seetickets-list-event-container`, `.headliners`,
  `.supporting-talent`, `.see-showtime`, `.see-doortime`, `.ages`, and `.price`.
  Treat selectors as versioned adapter configuration, with saved fixtures.
- Four calendar blocks carried `button-soldout` while their visible button said
  **More Info**. Preserve the status signal and verify its mapping with sample
  details; do not infer availability just from whether a ticket link exists.
- Ticket links use See Tickets, Eventim, and Ticketmaster. Some are wrapped in
  URL Defense links. A sample See Tickets link redirected to Eventim with the
  same numeric event ID `696618`. Preserve source aliases and original evidence;
  only equate provider IDs after verified redirects/mappings.
- Direct HTTP retrieval of that ticket detail returned **403**; ordinary browser
  navigation succeeded. The venue's list card already supplied most needed facts.
  The detail showed $20 face value versus $27.72 including fees, plus a $25 door
  price in its description. These are different price concepts, not conflicts.
- Observed programming includes live bands, DJ/dance events, and Nerd Nite.
  A themed dance night naming famous artists is not evidence they are performing.

### Recommended adapter

Use one ordinary GET of the full calendar for discovery, then the venue's own
paginated list for missing fields. Compare provider IDs between all list pages
and the full calendar before calling coverage complete. Cache extracted cards so
only changed/new items need further work. Prefer this to opening every ticket
page; a ticket-page 403 must not erase a calendar-discovered show.

Canonicalize ticket URLs for matching while preserving the original buy link.
Discard social-sharing URLs from candidate discovery. Decode recognized wrappers
only to a validated, allowed provider URL; unknown destinations need review.
Map the verified See Tickets/Eventim redirect as an alias, not a blanket claim
that IDs across all ticket providers share a namespace.

Use an explicit event-kind/scope rule. Retain non-music and ambiguous records in
the coverage report with their exclusion or review reason. Do not create artist
records from presenters, support labels, or dance-party themes. Carry the local
month/year from the calendar context; never guess a year from a short list date.

## Bottom of the Hill

Identity: Zivv `1016385760`, Bottom of the Hill, 1233 17th Street, San Francisco.
Website: <https://www.bottomofthehill.com/>; calendar:
<https://www.bottomofthehill.com/calendar.html>; feed:
<https://www.bottomofthehill.com/RSS.xml>.

### Observed behavior

- About 288 KB of HTML exposes **67 current/future event-detail URLs**, September 7
  through December 12. A historical 2018 link in surrounding navigation must be
  excluded. Scope discovery to actual event rows, not every date-shaped link.
- Event rows contain date/year, doors and music times, age, advance/door prices,
  fee-inclusive prices, ordered lineup, genres, and status images such as sold out.
  Read image alt/status markup without downloading posters. The site explicitly
  lists headliner first and opener last.
- Ticket URLs use venue-hosted `/stubmatic/eventYYYYMMDD.html` and
  `/dice/eventYYYYMMDD.html` paths. Keep those verified links; downstream ticket
  redirects were not audited and should not be guessed or treated as stable IDs.
- The calendar declares **ISO-8859-1**, while RSS declares UTF-8. Blind UTF-8
  decoding corrupted an accented artist name. Preserve bytes and decode the
  declared encoding before normalization/hashing parsed fields.
- Both resources expose ETag and Last-Modified. Initial If-None-Match probes with
  gzip-suffixed ETags returned 200; If-Modified-Since probes returned **304 with
  zero body bytes** for both resources. Test conditional behavior rather than
  assuming ETag support works identically across compression variants.
- RSS is an update history: **990 items, 545 distinct event links**, with 301 links
  repeated. There were 87 future-dated update items representing 66 distinct
  future event links. A GUID identifies a feed item, not necessarily a new show.
- Two feed entries for the October 6 show have different GUIDs and August 26 /
  September 2 timestamps; the later revision fills in a previously TBA support
  act. This is an update to one show, not a fresh announcement.
- The [October 8 event](https://www.bottomofthehill.com/20261008.html), listed as
  Casa Sueño with support on the calendar, had **no matching event URL in RSS**.
  A feed-only strategy would miss it. This finding refers to source coverage,
  not whether that show is already in Zivv.

### Recommended adapter

Fetch both calendar and RSS daily with conditional requests. Parse the complete
current calendar into canonical candidates; use RSS as a cheap revision signal
and provenance supplement. Compare the current calendar's event URLs with the
ledger and feed, and revisit changed detail pages only when needed.

Key on the canonical event-detail URL; track RSS GUIDs as revisions under it.
Retain explicit reschedule mappings if the date-based detail URL changes. Lineup
changes preserve Zivv's original date added. Feed `pubDate` is the publication
time of that update; do not automatically expose it as a verified first
announcement time. Taking the earliest retained item can still be incomplete if
older feed history has rolled off.

Extract `.date`, `.time`, `.age`, `.cover`, `.band`, `.genre`, and row status
markup with a tolerant HTML parser. Consecutive text spans can form one time or
date. Parenthetical band-member annotations are not extra performers. Keep face
value, door price, and fee-inclusive price separate.

## Preliminary comparison with this worktree

The comparison checked whether any event exists under the verified venue ID on
each source listing's local date. It did not perform full lineup matching or
validate cancellation history. A same-date match can still conceal a missing
second performance; a no-date match is a review candidate, not automatic proof
that an in-scope show was wrongly omitted.

| Venue | Source inventory examined | Dates with no corresponding local event | Examples to review |
| --- | --- | --- | --- |
| Fillmore | 55 non-package listings | 3 | Allison Russell, November 14; Yung Gravy, December 16; Death Angel, December 18 |
| Rickshaw Stop | 61 calendar occurrences | 14 | September 11, October 1, October 10; some other gaps are dance/non-music programming |
| Bottom of the Hill | 67 future detail URLs | 11 | September 16, October 6, October 12 |

These counts are against `public/data` with dataset version
`2026-08-22T01:09:30.583Z`. The sample found only one matching venue record for
each requested venue, and their existing aliases were checked. Counts must be
recomputed against the current canonical store before importing anything.
The investigation did not add candidate events or change their creation dates.

## Proposed daily behavior and cost

Use **zero model calls on the normal path** for these three adapters. That is a
design target supported by the observed fields, not a measured production token
bill. The interactive research session itself used model tokens.

| Source | Baseline work | Additional work |
| --- | --- | --- |
| Bottom of the Hill | Two conditional GETs; code parses changed resources | Changed/missing detail pages only; weekly full reconciliation |
| Rickshaw Stop | One calendar GET for discovery | Paginated list enrichment as needed; budget for up to all seven currently observed pages when checking full detail coverage |
| Fillmore | Paginated venue API request, subject to access/parity testing | Official-page audit; deterministic browser fallback and detail checks if API is unavailable |

Do not claim an exact request count before the Fillmore API and Rickshaw list
pagination are exercised end to end. Store content hashes and parsed candidates;
reparse when adapter/schema version changes. Network, browser, and maintenance
costs remain even when routine AI tokens are zero. A layout change or ambiguous
listing should become an explicit review item rather than silently invoking an
unbounded model crawl.

Keep the original plan's immutable `createdAtEpochMs` / date-added rule. Provider
creation dates, ticket on-sale dates, and RSS revision dates are separate facts.
Daily and weekly imports must use the same matcher and ledger; weekly additions
are selected by their original Zivv date-added range.

## Implementation order and acceptance fixtures

1. **URL integration and data contract:** validate the source registry and join it
   to venues by ID with name/address checks at ETL time. Populate `Venue.website`
   from `website`; keep crawling configuration outside browser JSON. Include the
   registry in source-change detection. Support unknown age/price, distinct
   doors/show times, and event kinds before unattended import.
2. **Bottom of the Hill pilot (lowest integration risk):** conditional fetch,
   encoding-aware calendar/RSS parsing, and revision matching. Fixtures must catch
   the October 8 RSS omission, October 6 revision, sold-out image, and fee breakdown.
3. **Rickshaw pilot (moderate):** full calendar discovery and all-page detail
   enrichment. Fixtures must preserve all 61 observed occurrences, handle an empty
   month before later shows, provider redirects/wrappers, status classes, and
   exclusion/review of non-live programming. Verify the untested pagination flow.
4. **Fillmore pilot (higher integration risk):** test documented API access and
   parity, or implement deterministic browser loading. Fixtures must catch 36
   versus 58 listings, unchanged JSON-LD after loading, three package products,
   and separate residency performances. Validate identity across API and ticket IDs.
5. **Shadow daily runs:** report discovered, matched, new, revised, excluded, and
   unresolved records per venue. Preserve the last good data on a failed source.
   Run one weekly cycle proving a daily addition remains in that week's list,
   then enable publication through the existing release gates.

No precise delivery estimate is justified until the two remaining integration
unknowns—Fillmore API parity and Rickshaw list pagination—are tested. Neither
requires an AI-first design. Existing `bd` tooling is unavailable here; these
follow-ups are documented for implementation rather than claimed as filed issues.
