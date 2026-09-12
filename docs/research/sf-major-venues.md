# San Francisco major venue source investigation

Investigated **2026-09-07** for 12 requested SF venue groups. This is a bounded source-discovery review, not an event import or a claim that any source inventory was fully counted. The machine-readable records are in [`data/research/sf-major-venues.json`](../../data/research/sf-major-venues.json). Existing venue IDs are preserved; `primaryVenueId` is included only where the official name/address makes the canonical row clear. Alias rows remain reconciliation candidates.

## Cross-source findings

- TicketWeb is the common ticket host for The Independent, Bimbo’s, Café du Nord/Swedish American Hall, and some August Hall and Castro events. A representative Independent link exposed a numeric TicketWeb event ID (`14176514`), but its detail request returned an access error. Keep the official card when detail access fails.
- See Tickets is used by Great American Music Hall and The Chapel. Both expose ordinary HTML list fields and month/calendar presentations. The Chapel currently shows seven numbered list pages; GAMH shows `LOAD MORE EVENTS` plus a month grid. These are pagination observations, not complete counts.
- AXS is the official ticket host for The Regency Ballroom and The Warfield. A representative Warfield AXS page exposed numeric event ID `1528340`, performer/support, age, doors, show time and the 982 Market address. Warfield's official list has a `Load More Events` control.
- Ticketmaster is used by Bill Graham Civic and some August Hall/Castro events. A representative Castro link exposed the stable hex event ID `1C00648F047E53DE`; the page was cookie/JavaScript constrained after basic event identity was visible. Do not treat a successful venue-page GET as complete provider coverage.
- Status text is operational data: current pages visibly include `SOLD OUT`, `SHOW CANCELLED`, `MOVED TO ...`, `POSTPONED`, `PRESALE`, `WAITLIST`, and `PRIVATE EVENT`. Import logic must preserve status and destination venue rather than interpreting every card as an in-scope upcoming concert.

## Venue records

### The Independent — ID 515101024

Observed on the [official event list](https://www.theindependentsf.com/event/) and [tickets page](https://www.theindependentsf.com/tickets/): list/detail cards provide title, support, date, show time, and TicketWeb links. The official [directions page](https://www.theindependentsf.com/directions-parking/) verifies **628 Divisadero Street, San Francisco, CA 94117**. Recommended adapter: parse the full official list and key by canonical TicketWeb URL or numeric event ID; pagination exhaustion and any venue-level provider ID remain unknown.

### Great American Music Hall — ID 463728167

The [official GAMH calendar](https://gamh.com/calendar/) provides list and month-grid cards with title, support, date, doors/show time, age/price/category, status and See Tickets links. The [contact page](https://gamh.com/contact/) verifies **859 O’Farrell St., San Francisco, CA 94109**. Recommended adapter: parse both presentations, deduplicate them, follow See Tickets only as enrichment, and explicitly filter `PRIVATE EVENT`/other-content records. `LOAD MORE EVENTS` and month navigation require an exhaustion check.

### The Chapel / Outdoor Stage — IDs 680116887, 506133276

The [official calendar](https://thechapelsf.com/calendar/) and [music list](https://thechapelsf.com/music/) expose title, support, date, doors/show time, age, price, genre, venue label and See Tickets links. The source explicitly labels `The Chapel Outdoor Stage`; this matches the existing `the Chapel Outdoor State` typo-like row as a room/stage alias. The official footer verifies **777 Valencia Street, San Francisco, CA 94110**. Recommended adapter: walk all seven visible list pages, key by See Tickets event ID/URL, and apply relocation notices such as `MOVED TO THE 4 STAR THEATER` before venue matching.

### August Hall — ID 811075932

The [official calendar](https://www.augusthallsf.com/calendar/) and [events list](https://www.augusthallsf.com/events/) are paginated (visible pages 1–3), expose dates/titles and mixed Ticketmaster/TicketWeb links, and have [individual event pages](https://www.augusthallsf.com/tm-event/show-me-the-body/) with doors, show time and age. The [venue overview](https://www.augusthallsf.com/venue-overview/) verifies **420 Mason Street, San Francisco, CA 94102**. Recommended adapter: parse official WordPress pages, retain provider-specific event IDs, deduplicate repeated presentations, and preserve moves such as `Futurebirds – MOVED TO THE CHAPEL`.

### Bimbo’s 365 Club — ID 697962111

The [official shows pages](https://bimbos365club.com/shows/) expose title, support, date, doors/show time, age, sold-out state and TicketWeb links across visible pages 1–3. The official [venue page](https://bimbos365club.com/tm-venue/bimbos-365-club/) verifies **1025 Columbus Avenue, San Francisco, CA 94133**. A [Ticketmaster venue page](https://www.ticketmaster.com/bimbos-365-club-tickets-san-francisco/venue/229790?tt_scene=anchor_view) and [AXS venue page](https://www.axs.com/venues/128958/bimbos-365-club-san-francisco-tickets/staticDetails) expose provider website venue numbers `229790` and `128958`; these are not Ticketmaster Discovery API IDs, and the official site currently links TicketWeb, so cross-provider parity is unverified. Preserve notices such as `MOVED TO THE CASTRO THEATRE` and `SOLD OUT`.

### The Regency Ballroom — ID 2133080253

The [official Goldenvoice shows page](https://www.theregencyballroom.com/shows/) uses AXS ticketing and exposes title, support, date, doors/show time and age. The [FAQ](https://www.theregencyballroom.com/faq/) and [venue info](https://www.theregencyballroom.com/venue-info/) verify **1300 Van Ness Avenue, San Francisco, CA 94109**. Recommended adapter: use the official page for discovery and AXS IDs for stable keys, while excluding sibling Regency Center rooms Social Hall SF and The Lodge. The shows payload is client-rendered and complete load behavior was not enumerated.

### The Warfield — ID 1531618194

The official [calendar](https://www.thewarfieldtheatre.com/events) exposes AXS links and a `Load More Events` control. A representative [AXS event](https://www.axs.com/events/1528340/bikini-kill-tickets?skin=warfield&src=AEGLIVE_WWRFLSFO022715VEN001) exposed event ID `1528340`, title/support, age, doors/show time and address. The official [FAQ](https://www.thewarfieldtheatre.com/venue-info/frequently-asked-questions) verifies **982 Market Street, San Francisco, CA 94102**. Recommended adapter: parse official cards, key by AXS event ID, and preserve AXS cancellation/reschedule state; complete horizon and venue ID remain unknown.

### The Masonic — existing ID 1120524281 (`Masonic Center`)

The official [Masonic shows page](https://www.sfmasonic.com/shows) provides list/calendar views, and verified month URLs such as [September 2026](https://www.sfmasonic.com/shows/calendar/2026-09). The direct list response is client-loaded and the month page can render only calendar scaffolding, so this source is **partial**. [Visit](https://www.sfmasonic.com/visit) and Live Nation’s [venue page](https://premium.livenation.com/venue/the-masonic) verify **1111 California Street, San Francisco, CA 94108**. Use the official Live Nation surface for discovery and validate Ticketmaster event links after client data is available; no complete inventory or provider venue ID was observed.

### Café du Nord — ID 1550837691

The [official shared calendar](https://cafedunord.com/calendar/) is paginated (visible pages 1–4), uses TicketWeb, and exposes promoter, title, support, show time, venue label, age and waitlist/sold-out state. The [official directions page](https://cafedunord.com/directions/) verifies **2174 Market St, San Francisco, CA 94114**. The generated row currently has address `Inc.`; correct it only through the later ETL/reconciliation change. The adapter must filter cards explicitly labeled Café du Nord because the same calendar contains Swedish American Hall events.

### Swedish American Hall — existing ID 927889318

The official [Swedish American Hall site](https://www.swedishamericanhall.com/) identifies the upstairs venue and verifies **2174 Market Street, San Francisco, CA 94114**. It does not expose a public event calendar in this probe. The official [Café du Nord shared calendar](https://cafedunord.com/calendar/) does expose Swedish American Hall cards with TicketWeb links, so use that source with strict venue-label filtering. The generated row says `2170 Market Street`; preserve ID `927889318` and flag the 2170/2174 discrepancy for reconciliation rather than silently rewriting it.

### The Castro Theatre aliases — IDs 881479351, 1383208152, 1730654249, 905826547, 1956100968

The [official calendar](https://thecastro.com/calendar/) exposes title, date, doors/show time, venue label, mixed Ticketmaster/TicketWeb links, and explicit cancelled, moved, sold-out and presale states. A representative [Ticketmaster event](https://www.ticketmaster.com/the-charlatans-north-american-tour-2026-san-francisco-california-09-07-2026/event/1C00648F047E53DE?brand=anotherplanet&camefrom=CFC_ANOTHERPLANET_web) exposes stable hex event ID `1C00648F047E53DE`. The [box-office page](https://thecastro.com/venue-info/tickets-box-office/) verifies **429 Castro St, San Francisco, CA 94114**. Existing `Castro` and `Castro Theater` rows overlap current programming while typo/parenthetical aliases are empty; retain all IDs and compare canonical provider event IDs before any merge.

### Bill Graham Civic Auditorium aliases — IDs 1648637995, 1805757855, 1211018360, 1414808200

The [official calendar](https://billgrahamcivic.com/calendar/) exposes title, date, doors/show time, support, Ticketmaster links and explicit sold-out/rescheduled/moved states. The official [venue home](https://billgrahamcivic.com/) verifies **99 Grove St., San Francisco, CA 94102**. Existing ID `1648637995` is the exact `Civic Auditorium` row and is the safe primary candidate. `the Civic Audtorium` and `ht Civic Auditorium` are empty typo aliases. `the Civic` has a corrupted city value (`135`) and a Movements record, so it remains unresolved; do not merge it or San Jose Civic/City National Civic records without an address/provider-event match.

## Implementation boundary

These records recommend deterministic HTML/provider adapters and preserve source status, provider IDs, and canonical URLs. They do not enable crawling, change generated event data, repair venue rows, or assert complete counts. The next safe step is fixture-backed reconciliation per venue, starting with the ordinary HTML sources (Chapel/GAMH/Café du Nord) and then the client-loaded AXS/Live Nation surfaces.
