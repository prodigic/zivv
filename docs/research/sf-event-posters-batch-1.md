# San Francisco show artwork research — batch 1

Checked 2026-10-10. Input: `.cache/sf-poster-venues-1.json` (16 venues, 219 listed upcoming shows). Output: `.cache/sf-poster-results-1.json` (107 exact matches: 39 posters and 68 show-specific event-artwork items).

## Method and acceptance

Fetched official venue calendars and linked show pages in batches per venue, then parsed their HTML, embedded JSON/metadata, and structured event data for dates, artist names, venue identity, outbound detail URLs, and image candidates. Matches require the listed date, headliner, and venue to agree with the first-party source; venue namesakes and moved/rescheduled shows were checked against the page details. Kept the observed show-specific detail or official-linked ticket URL in `eventUrl`. Generic venue marks and unverified aggregator art were excluded. A small visual sample was used to distinguish designed flyers from promotional/event images. Finally made 212 HTTPS checks across 106 unique page URLs and 106 image URLs; all returned HTTP 200 and every image had an image MIME type. Only qualified rows are in the results JSON; unverified candidates are omitted.

## Venue coverage

| Venue | Listed | Matched | Official source and result / gap |
|---|---:|---:|---|
| Castro | 60 | 38 | [Official listings](https://thecastro.com/listing/) and linked show pages. Remaining input rows had no exact qualifying show-page/image match in the checked listing. |
| Rickshaw Stop | 46 | 0 | [Official calendar](https://rickshawstop.com/calendar/) was indexed and yielded show text, but direct fetch returned 403; no image was recoverable from the accessible source. This is a source-access gap, not a no-artwork finding. |
| Bottom of the Hill | 44 | 29 | [Official calendar](https://www.bottomofthehill.com/calendar.html) links exact show pages and show-specific flyer files. Remaining listed rows were not represented by an exact matching calendar entry. |
| Bimbo’s 365 Club | 27 | 17 | [Official shows](https://bimbos365club.com/shows/) and linked event pages. One apparent Maro date was excluded because the page documents a move from Castro to Bimbo’s on Oct 12; only the exact Bimbo’s date is included. |
| Knockout | 11 | 7 | [Official event listings](https://theknockoutsf.com/events-2-1) and detail pages. Croissant’s official page gives Sep 30, not the listed Oct 17 date, so it was excluded. |
| Civic Auditorium | 10 | 8 | [Official calendar](https://billgrahamcivic.com/calendar/) and linked event pages. Two listed rows did not have an exact qualifying match. |
| On Broadway (The Mab) | 6 | 3 | [Official site](https://themab.org/) and its linked event listings/pages. Three exact show posters found; the other listed rows had no exact page/art match in checked listings. |
| Neck of the Woods | 5 | 2 | [Official site](https://www.neckofthewoodssf.com/) and linked ticketed show pages. Two exact matches; remaining rows had no qualifying exact page/image match. |
| Cafe Du Nord | 2 | 2 | [Official calendar](https://cafedunord.com/calendar/) and linked event pages; both rows matched. |
| Thrillhouse Records | 2 | 0 | [Official calendar](https://thrillhouserecords.com/pages/calendar) and date-specific posts were checked. Static pages exposed text/logo content but no usable show-specific artwork; unresolved, not a no-artwork conclusion. |
| Midway | 1 | 0 | Officially linked [Tixr event page](https://www.tixr.com/groups/midwaysfgv/events/tinlicker-live-186833) identifies Tinlicker, Oct 10, and The Midway, but automated access returned 403 and did not expose a verifiable image URL. |
| above DNA Lounge | 1 | 0 | [Official calendar](https://www.dnalounge.com/calendar/2026/10-24a.html) lists a different Oct 24 show (Ghoul at DNA Lounge), not the input’s Warumono / “above DNA Lounge” match. Exact venue/event identity and artwork remain unresolved. |
| Feinstein’s at the Nikko | 1 | 1 | Official [Carol Luckenbach event page](https://www.feinsteinssf.com/tm-event/carol-luckenbach-under-the-influence/) identifies the exact date and venue and supplies show-specific art. |
| Biscuits and Blues | 1 | 0 | [Official show finder](https://www.biscuitsandblues.com/find-a-show) was checked; no first-party page for the listed Westerly date was found. No conclusion about artwork availability. |
| O’Reilly’s | 1 | 0 | No official venue calendar/site was identified for the listed event; third-party references were not accepted as artwork evidence. |
| Mothbelly Gallery | 1 | 0 | No first-party event source was identified for the listed event; unresolved, not a no-artwork finding. |

## Limits

Coverage counts are qualifying exact matches, not claims that unrepresented shows have no artwork. Rickshaw and Midway pages had access restrictions; Thrillhouse’s checked static source did not expose show-specific images; DNA Lounge’s observed listing conflicts with the input’s venue/performer identity. The one-off venue entries without a usable first-party event page remain unresolved. The parent task owns integration, export, and publication.
