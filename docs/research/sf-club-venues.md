# SF club venue source investigation

Investigated 2026-09-07 for the requested San Francisco club set. This is a
source-onboarding report; it does not enable an importer or change generated
event data. Structured records are in
[`data/research/sf-club-venues.json`](../../data/research/sf-club-venues.json).

The result contains 12 source records: 11 requested venue identities plus a
separate `above DNA Lounge` room record. Six are `verified`, five are `partial`,
and the separate Above DNA room is `unverified`. A verified status means that a
first-party identity/address and a usable first-party event surface were
observed; it does not mean the entire future inventory or provider parity has
been proven.

## Data join and alias audit

The targeted records in [`public/data/venues.json`](../../public/data/venues.json)
have unique venue IDs. Existing aliases and data issues are:

| Identity | Existing IDs | Join finding |
| --- | --- | --- |
| DNA Lounge | `405307007`; typo `447883166` | Canonical address is `375 11th Street at Harrison`, city `S.f`; typo alias has blank address/city. |
| Above DNA Lounge (separate room candidate) | `1009706718` | Blank address; keep separate until the official source confirms the room label. |
| Black Cat | `1082531611`; `186436097` | Canonical has `400 Eddy Street`, `S.f`; `the Black Cat S.F.` alias has blank address/city. |
| Make Out Room | `337931090`; `398859205`; `879587410` | Canonical has `3225 22nd St. at Mission`; two punctuation/name aliases have blank addresses. |
| Kilowatt, Knockout, Neck of the Woods, Hotel Utah Saloon, El Rio, Eagle Tavern, Great Northern, Midway | one ID each | Existing addresses are plausible but cities are normalized as `S.f`; compare by name and address, never by city string alone. |

The generated DNA records contain a same-date likely duplicate/review pair:
`Johnny Manchild` (`709315056`, DNA Lounge) and misspelled `Jonhhy Manchild`
(`170617613`, Above DNA Lounge), both on 2026-09-13. This could be a room
split, duplicate, or typo; the source does not establish which.

## Findings by venue

### DNA Lounge and Above DNA Lounge

The official source is [DNA Lounge calendar](https://www.dnalounge.com/calendar/),
but the calendar and site were denied by robots.txt in the web check. The
[San Francisco Legacy Business record](https://www.sf.gov/sites/default/files/2024-11/item_3d._lbr-2017-18-007_dna_lounge.pdf)
confirms 375 11th Street, San Francisco, CA 94103 and describes four
performance spaces with all-ages, 18+ and 21+ music/dance programming plus
comedy and other performances.

The minimal adapter is blocked pending first-party access: use official event
detail URLs or provider IDs as keys, preserve age/event kind/status, retain the
room field, and keep source identity in a ledger across edits or reschedules.
Do not merge Above DNA into the main room until a source page names it.
Provider, feed/API, pagination, full horizon, stable IDs and ticket host remain
unknown.

### Kilowatt

[Kilowatt’s official site](https://kilowattbar.com/) and [contact page](https://kilowattbar.com/contact)
confirm 3160 16th Street, San Francisco, CA 94103. The official [events page](https://kilowattbar.com/events)
is labeled calendar, but its fetched HTML exposed only a search/calendar shell;
event cards did not render. The home page describes weekly live music and DJ
nights after the venue’s earlier punk/rock/indie period.

Use a JavaScript-capable DOM adapter after checking the rendered page and any
pagination. Proposed scope is live shows and DJ nights; ordinary bar activity
is not an event candidate. Provider, event IDs, feed, status and full horizon
are unknown.

### The Knockout

The official [calendar page](https://theknockoutsf.com/calendar2) confirms
3223 Mission Street, San Francisco, CA 94110. The richer official [events list](https://theknockoutsf.com/events-2-1)
contains dated records with start/end times, descriptions, Google Calendar and
ICS links. Sample event URLs have opaque stable path tokens, and the observed
list runs from late August/September through at least December 2026.

The minimal adapter reads the event collection and follows the first-party ICS
link when needed. It must classify band bills separately from karaoke, comedy,
trivia, vinyl/DJ and dance-party records. No provider venue ID, ticket host or
stable-edit/cancellation semantics were exposed; verify whether the opaque
path remains stable after edits.

### Neck of the Woods

The official [calendar](https://www.neckofthewoodssf.com/) exposes event cards,
doors/show times, prices, lineup text, `More Info` and [TicketWeb](https://www.ticketweb.com/)
links. The official [contact page](https://www.neckofthewoodssf.com/contact/)
confirms 406 Clement Street, San Francisco, CA between 5th and 6th Avenue, and
the [About page](https://www.neckofthewoodssf.com/about-us/) confirms a two-floor
independent music venue that also hosts comedy and private events.

The visible list has numbered pagination through 12. Use the first-party list
as discovery, follow TicketWeb only for enrichment, and key by canonical detail
URL/provider ID once observed. Retain doors, show, price and lineup separately;
classify salsa, karaoke and comedy explicitly. A 12-page snapshot is not proof
of an exhaustive horizon.

### The Hotel Utah Saloon

The official [home page](https://hotelutah.com/) and [calendar](https://hotelutah.com/calendar/)
confirm 500 4th Street, San Francisco, CA 94107. The calendar provides list and
month views with date, title, genre, 21+ age, price, show time and lineup. It
showed September through November 2026 records, with blank later months that
cannot be treated as exhaustion. First-party event paths use
`/seetickets-event/`, indicating a venue-side See Tickets integration, but no
provider venue ID was visible.

Use the calendar for discovery and event-detail pages for enrichment. Proposed
scope includes open mics and bluegrass jams as event kinds instead of artist records. The
calendar request timed out once, so retrieval and month navigation need a
fixture/conditional-fetch check; exact ticket host, stable provider ID and
cancellation semantics remain unknown.

### El Rio

Official [home](https://www.elriosf.com/home), [About](https://www.elriosf.com/about/)
and [FAQ](https://www.elriosf.com/faq) pages confirm El Rio at 3158 Mission
Street, San Francisco, CA 94110, a queer neighborhood bar/community space and
patio. About content describes live music, salsa, rock, country, pop, queer
dance, drag and benefits. Proposed scope includes live music; the FAQ says most shows are cash at the door, with
some promoter-controlled presales.

The home page has a Calendar/View Calendar CTA, but the bounded web check
returned the home page rather than a dedicated calendar or event inventory.
Leave `calendarUrl` null until the CTA target is resolved. A JavaScript-capable
inspection is the next step; provider, pagination, event fields, IDs, status,
feed and ticket hosts are unknown.

### SF Eagle / Eagle Tavern

The official [SF Eagle events list](https://sf-eagle.com/events/list/) and home
page confirm 398 12th Street, San Francisco, CA 94103. The WordPress Events
Calendar exposes list/month/day/photo/week views, title, date, start/end times,
descriptions, venue label, and Google/iCalendar/Outlook exports. The page uses
`SF Eagle Bar` while the generated legacy record is `Eagle Tavern`; preserve
both names for matching.

Programming includes beer busts, drag, karaoke, comedy, leather/community
socials, resident DJs and dance nights, with some live music bills. Proposed
scope includes music and clearly eventized programming; use an event-kind rule and do not turn party names into artists. The exact ICS target,
WordPress post IDs and cancellation/status conventions still need extraction.

### Make Out Room

The official [events page](https://www.makeoutroom.com/) provides a dated
reverse-chronological inventory with titles, DJ/artist or presenter names,
genres/descriptions, door/show windows and prices. The official [calendar page](https://www.makeoutroom.com/calendar.html)
embeds CalendarWiz. The official [home/identity page](https://www.makeoutroom.com/mhome.html)
confirms 3225 22nd Street & Mission, San Francisco, and 21+ entry.

This was one of the two deeper checks. A sample event links presale to
Eventbrite and other entries link Instagram; the dedicated CalendarWiz iframe
exposes no account/event IDs in the bounded output. Start with the events page,
then reconcile CalendarWiz by source ID/URL and retain any provider ID
discovered in the iframe. Date/title matching is only a collision review aid,
not authoritative identity. Proposed scope includes live bills; preserve
dance/DJ, drag, karaoke, storytelling and comedy as explicit event kinds.

### Black Cat

The official [Black Cat site](https://blackcatsf.com/) confirms 400 Eddy Street,
San Francisco, CA 94109 and describes a jazz supper club. Its first-party
[Turntable Tickets show list](https://blackcatsf.turntabletickets.com/) and
[calendar](https://blackcatsf.turntabletickets.com/calendar) provide titles,
dates, ticket tiers, fee notes, doors, one or two show sessions, descriptions
and band lineups. A representative [show detail](https://blackcatsf.turntabletickets.com/shows/12455/2026-09-02)
uses the stable URL form `/shows/{numeric-show-id}/{date}`; residency pages use
`/r/{slug}`.

This was the second deeper check. Early and late ticketable performances are
distinct occurrence/session keys (show ID + date + session), even when grouped
on one page; preserve source identity in the ledger across edits/reschedules.
Numeric Turntable show IDs plus canonical URL are the minimal event key. The calendar itself initially returns a loading shell; full horizon,
calendar loading behavior, venue ID and cancellation/status need fixtures.

### The Great Northern

The official [home page](https://www.thegreatnorthernsf.com/) has an Upcoming
Events section but no event cards in the bounded HTML response. Its [contact page](https://www.thegreatnorthernsf.com/contact-us)
prints 119 Utah St., San Francisco, but contains a malformed `941o3` ZIP (the
fourth character is a letter o in place of zero). The [AXS venue page](https://www.axs.com/venues/128662/the-great-northern-san-francisco-tickets/staticDetails)
supports 119 Utah Street, San Francisco, CA 94103 and exposes an 11-event
sample with numeric AXS venue/event IDs; at least one provider listing is
marked moved from Monarch. Eventbrite is also visible for at least one event.

Treat AXS and Eventbrite as provider observations requiring parity checks, not
as proof that the first-party calendar is exhaustive. The adapter must render
the official event block, retain room/loft labels and moved/rescheduled data,
and classify themed dance/tribute nights without inventing performers.

### The Midway

Official [home](https://themidwaysf.com/), [events](https://themidwaysf.com/events/),
[contact](https://themidwaysf.com/connect/contact/) and [venue rental](https://themidwaysf.com/connect/venue-rental/)
pages confirm 900 Marin Street, San Francisco, CA 94124 and the room set RiDE,
Gods & Monsters, The Terrace, 888 Garage and block parties. The first-party
events page explicitly reports JavaScript disabled/failed loading in the
bounded check. The contact page directs ticket questions to Tixr, while the
[Ticketmaster venue page](https://www.ticketmaster.com/the-midway-billets-san-francisco/venue/230127)
exposes venue `230127` and a 19-event sample.

Use rendered first-party events as the discovery baseline, then reconcile Tixr
and Ticketmaster by canonical event ID and room. Preserve room/session data;
music shows, electronic performances and clearly eventized workshops/art need
event-kind classification. Tixr ID, official event API, full horizon,
cancellation/status semantics and provider parity are unknown.

## Minimal adapter plan and blockers

The lowest-token normal path is deterministic HTML/ICS/provider parsing with no
model calls. Use canonical source event IDs or URLs, retain doors/show times,
lineups, ticket status and room/session fields, and classify non-concert club
programming instead of creating false artist records.

The current blockers are first-party access/rendering: DNA is robots-blocked;
Kilowatt, El Rio, Great Northern and Midway expose event shells without the
event inventory in bounded HTML; Hotel Utah timed out once; Black Cat’s calendar
loads asynchronously; and several providers do not expose a venue ID in the
first-party page. Resolve those with a browser-capable fixture pass before
enabling any adapter. No imports, code, schedules or generated data were
changed by this investigation.
