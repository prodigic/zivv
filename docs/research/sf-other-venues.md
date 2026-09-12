# SF other-venue source investigation

Investigated 2026-09-07 for the requested San Francisco venue group. This is a
source-onboarding record only: no importer is enabled and no generated event
data was changed. Existing Zivv IDs are preserved in
[`data/research/sf-other-venues.json`](../../data/research/sf-other-venues.json).

The source pages were checked as public pages. `observed` means directly visible
on the official page, `inferred` means an adapter recommendation from those
observations, and `untested` means an implementation or coverage question that
was not established by this bounded check. A `partial` status means the page is
useful but has a material scope, identity, rendering, or coverage limitation.

## Findings at a glance

| Existing venue IDs | Official identity and SF address | Public source | Status | Main risk |
| --- | --- | --- | --- | --- |
| 89816907, 392702093 | 4 Star Theater, 2200 Clement Street, San Francisco, CA 94121 | [CinemaSF Bay calendar](https://www.4-star-movies.com/calendar-of-events) | partial | Movie theater calendar mixes films, private events, Q&As, and live music |
| 1652761549 | The Lab, 2948 16th Street, San Francisco, CA 94103 | [The Lab](https://www.thelab.org/) | partial | Experimental music is mixed with exhibitions and other art programs |
| 698121015 | The Lost Church - San Francisco, 988 Columbus Avenue, SF, CA 94133 | [SF events](https://thelostchurch.org/san-francisco/) | partial | SF and Santa Rosa are separate pages; music is mixed with comedy, readings, film, and variety |
| 735357859 | Thrillhouse Records, 3422 Mission Street at 30th, San Francisco, CA 94110 | [event calendar](https://thrillhouserecords.com/pages/calendar) | partial | Shopify calendar is sparse and links to blog posts; no stable ticket/feed contract exposed |
| 1185666454 | Peacock Lounge, 552 Haight Street, San Francisco, CA 94117 | [events](https://sfpeacock.org/events/) | partial | Current page has only “Coming Soon, 2026” and a recurring descriptor |
| 1282095081 | The Plough and Stars, 116 Clement Street at 2nd Avenue, San Francisco | [monthly calendar](https://theploughandstars.com/) | verified | Static day-cell calendar has no per-event IDs; scope includes non-concert nights |
| 2013304995, 718099583 | Amoeba Music - San Francisco, 1855 Haight Street, San Francisco, CA 94117 | [upcoming shows](https://www.amoeba.com/live-shows/upcoming/) | partial | Stored ID 2013304995 carries Berkeley address 2455 Telegraph; branch must be selected explicitly |
| 1237996847 | 1015 Folsom, 1015 Folsom Street, San Francisco, CA 94103 | [official calendar](https://1015.com/#calendar) | verified | Club calendar has filters and ticket/sign-up states; all events are 21+ |
| 390079947 | Palace of Fine Arts Theatre, 3301 Lyon Street, San Francisco, CA 94123 | [events](https://www.palaceoffinearts.org/events) | partial | Four-page listing mixes music, comedy, ballet, podcasts, film, and postponed events |
| 793025194, 261131824 | Chase Center, 1 Warriors Way, San Francisco, CA 94158 | [Chase Center events](https://www.chasecenter.com/events/) | partial | Central calendar rendered an empty shell/error; old stored names/addresses are ambiguous |
| 1276498217, 1094184065 | Stern Grove Festival, 19th Avenue and Sloat Boulevard, San Francisco, CA 94132 | [2026 lineup](https://www.sterngrove.org/lineup2026) | partial | 2026 season is complete; future season URL/coverage is untested |

## Source notes

### 4 Star Theater

The [official CinemaSF Bay calendar](https://www.4-star-movies.com/calendar-of-events)
is publicly readable. Cards expose a date, start/end time, title, description,
detail-page slug, and Veezi ticket link. A current sample includes a live-music
afterparty, film screenings, a private-event closure, and a film/dance program.
The [contact page](https://www.4-star-movies.com/contact) confirms 2200 Clement
Street, San Francisco, CA 94121.

`inferred`: use the official detail URL as the event key and retain the Veezi
purchase/session link separately. Apply an event-kind rule before artist
creation. `untested`: complete archive/horizon and pagination behavior, plus a
provider venue ID.

The two stored IDs are duplicate aliases; `392702093` is addressless. No merge
is made here.

### The Lab

The [official homepage](https://www.thelab.org/) currently lists dated projects
with title, start/end time, doors/show time, price, detail page, and DICE short
link. The [Heart Trio detail page](https://www.thelab.org/projects/2026/9/11/heart-trio-william-parker-hamid-drake-cooper-moore)
confirms the address, event fields, and `link.dice.fm` ticket host. The [info
page](https://www.thelab.org/info) also confirms 2948 16th Street, San Francisco,
CA 94103.

`inferred`: key by the dated project URL and preserve DICE as ticket provenance.
The Lab's exhibitions and other experimental art work require explicit
music/nonmusic classification. `untested`: full future-project pagination and
DICE ID/redirect behavior.

### The Lost Church (SF only)

The [official SF page](https://thelostchurch.org/san-francisco/) states 988
Columbus Avenue, SF, CA 94133 and shows a public dated card list. Cards carry a
title, month/day/year, Read More link, and Buy Ticket link. The links expose
Salesforce ticket instance hashes such as the public
[`/ticket#/instances/...`](https://thelostchurch.my.salesforce-sites.com/ticket#/)
surface. Santa Rosa is a separate page and is out of scope.

Current programming includes music, standup, readings, documentary screenings,
theater, and variety shows. `inferred`: use the Salesforce instance ID plus the
official card title/date as the candidate key, then classify event kind.
`untested`: Salesforce detail fields, cancellation semantics, and calendar-view
coverage.

### Thrillhouse Records

The [official About page](https://thrillhouserecords.com/pages/about-us) confirms
3422 Mission Street at 30th Street, San Francisco, CA 94110 and describes a
volunteer-run DIY record store. The [Shopify calendar](https://thrillhouserecords.com/pages/calendar)
is public and links to `/blogs/shows-and-events` posts. On the check date it
showed September 12-13 and September 27 entries, but only sparse date headings
and a page-update label; a current post is a film event, demonstrating the scope
risk.

`inferred`: use canonical show-blog URLs, parse post body date/title/venue/ticket
fields, and ignore product pages. `untested`: complete post retention,
pagination, and any stable feed or ticket identity.

### Peacock Lounge

The [official contact page](https://sfpeacock.org/contact-us/) confirms 552 Haight
Street, San Francisco, CA 94117. The [official events page](https://sfpeacock.org/events/)
is reachable but currently says “Coming Soon, 2026,” gives doors at 7PM/show at
8PM, and repeats “Every Third Thursday of the Month.” It exposes no concrete
upcoming title, date, detail URL, or ticket host. The [homepage](https://sfpeacock.org/)
describes concerts, spoken word, record releases, intimate performances, and
private/corporate uses.

`inferred`: keep the adapter disabled until a dated event contract appears;
recurring copy is not enough to create events. `untested`: whether concrete
announcements arrive through later page injection or an unlinked channel.

### Plough and Stars

The [official homepage](https://theploughandstars.com/) identifies The Plough and
Stars at 116 Clement Street at 2nd Avenue, San Francisco, and displays the
September 2026 monthly calendar. Day cells contain named bands, sessions, and
other programming; the page states shows start at 9PM unless otherwise noted
and reports a September 7, 2026 update.

`inferred`: parse the day-cell date plus normalized event text as a matching
fingerprint and preserve the stated default time. Keep that fingerprint in a
ledger/review workflow rather than treating it as a durable provider ID, and
keep same-day performances separate. Filter set dancing, trivia, board-game
nights, and similar non-concert entries. `untested`: monthly archive
navigation and future-month publication behavior; no feed or provider ID was
exposed.

### Amoeba Music / Records (Haight SF only)

The [official stores page](https://www.amoeba.com/our-stores/) and [FAQ](https://www.amoeba.com/other/faq/)
separately identify San Francisco at 1855 Haight Street, San Francisco, CA
94117, Berkeley at 2455 Telegraph Avenue, and Hollywood at 6200 Hollywood
Boulevard. The [upcoming shows page](https://www.amoeba.com/live-shows/upcoming/)
has branch-specific sections and dated title/time/description entries; the SF
sample is a September 11 book signing/DJ set.

The generated row `2013304995` is named Amoeba Music but stores `2455 Telegraph`
with city `S.f`; that is the official Berkeley address paired with a corrupted
city value. `718099583` is an addressless Amoeba Records alias. These IDs remain
in the research row for reconciliation and are not silently certified as the SF
venue.

`inferred`: select only the explicit San Francisco branch, preserve branch in
provenance, and reject Berkeley/Hollywood cards. `untested`: event-card
pagination/retention and stable per-event URLs.

### 1015 Folsom

The [official About page](https://1015.com/about/) confirms 1015 Folsom Street,
San Francisco, CA 94103 and says all events are 21+. The [official homepage
calendar](https://1015.com/#calendar) currently exposes 15 upcoming cards,
month/day/status/genre filters, detail URLs under `/events/`, artist/support
text, and ticket or sign-up states. A current detail page such as [D.DAN](https://1015.com/events/throttle-d-dan-2026-09-10/)
links to `wl.seetickets.us` and exposes date/title information.

`inferred`: key by the official detail slug and retain See Tickets event IDs and
URLs as aliases; distinguish event existence from ticket/signup status.
`untested`: filter pagination and inventory beyond the current 15 cards.

### Palace of Fine Arts

The [official events listing](https://www.palaceoffinearts.org/events) confirms
3301 Lyon Street, San Francisco, CA 94123 and reports Page 1 of 4. Listing cards
expose title/date/start time and canonical `/event/slug/` URLs. A [detail-page
sample](https://www.palaceoffinearts.org/event/the-tallest-man-on-earth/) adds
door time, ticket link, seating/map links, and a `folkyeah.com` ticket host.

`inferred`: crawl all four listing pages, key by detail URL, retain door time and
postponed status, and classify event kind. `untested`: page-count changes,
historical retention, and ticket-host consistency across all details.

### Warriors Stadium / Chase Center

The [official Chase Center homepage](https://www.chasecenter.com/) and [official
Warriors ticket account](https://am.ticketmaster.com/warriors/) identify the
arena address as 1 Warriors Way, San Francisco, CA 94158. Official per-event
pages expose title, date, start/event time, doors when applicable, description,
ticket and venue/travel sections; examples are [Joji](https://www.chasecenter.com/events/joji-20260714/)
and [Harmonic Jam](https://www.chasecenter.com/events/harmonic-jam-20260809/).

The central [events page](https://www.chasecenter.com/events/) rendered an empty
shell in the browser check. The official community page's calendar currently
reported an event-fetch error. Therefore discovery completeness is not
established even though per-event pages are public.

The existing `793025194` row called Warriors Stadium has `300 16th Street`,
which does not match Chase Center; `261131824` called Warrior's Arena is
addressless. Both are carried as ambiguous aliases for ETL review.

`inferred`: keep sports, concerts, and Thrive City/community records as separate
event kinds and do not auto-join the old IDs to Chase Center. `untested`: the
official discovery endpoint/API, pagination, and provider ticket venue ID.

### Stern Grove Festival

The [official homepage](https://www.sterngrove.org/) and [2026 lineup](https://www.sterngrove.org/lineup2026)
identify the venue as 19th Avenue and Sloat Boulevard, San Francisco, CA 94132.
The lineup page exposes dated headliner, support/DJ text, and ticket-state labels;
all 2026 dates observed on September 7 were sold out or lottery closed, with
table options on some dates. The homepage says the 2026 season is complete and
points to next summer's 90th season.

`inferred`: use the season lineup URL plus date/headliner/support as a matching
fingerprint, preserve it in a season ledger/review workflow rather than treating
it as a durable provider ID, and keep same-day performances separate. Keep
lottery/sold-out labels separate from event status. The two stored IDs
(`1276498217` Stern Grove and `1094184065` Stern Grove Festival) represent the
same name/location family and need an ETL merge decision. `untested`: next-season
URL/archival behavior and provider ticket identity. The completed 2026 season is
not evidence that the festival is closed.

## Adapter/deployment boundary

These records should remain disabled until source-specific fixtures and scope
rules exist. The safest implementation order is Plough and Stars or 1015 for
structured pilots, then The Lab/Lost Church with explicit event-kind filtering.
Treat 4 Star, Palace, and Chase as coverage/scope-heavy; treat Amoeba and the
old Warriors IDs as identity-repair work; and leave Peacock on review until its
official page exposes concrete dated events. All normalized candidates should
retain the official URL and observed source text so later changes can be
reconciled without inventing provider IDs.
