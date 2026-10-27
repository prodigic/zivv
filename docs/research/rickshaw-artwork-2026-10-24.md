# Rickshaw Stop artwork repair

Reviewed October 24, 2026 for #138.

The October 10 artwork audit recorded zero accepted Rickshaw images because the official calendar returned HTTP 403. This was an access gap. The venue adapter currently imports show facts without artwork, and its source remains disabled; this repair does not activate scheduling.

## Accepted evidence

Added 32 show-specific `event-artwork` entries to `data/event-posters.json`, bound to canonical event ID, slug, date, venue ID/name and headliner ID/name. Sources are the official [calendar](https://rickshawstop.com/calendar/) and its linked Eventim pages, supplemented by the official [Popscene listings](https://popscenepresents.com/new-events). Each entry records its exact ticket URL, primary image, reviewed date and image-byte SHA-256.

The venue-linked Eventim `afflky` parameter is necessary to obtain the full branded event page. Stripping it returned an unhelpful generic page. Use the actual source link; do not assume it is disposable tracking. Inspect the primary `.event-hero__img.event-image` and primary `time[itemprop=startDate]`; recommendation cards and queue-page images are not show evidence. Some pages omit JSON-LD, so visible primary show identity/date and Rickshaw's venue/address were checked too.

Artist title exceptions were individually reviewed: PSYCHED! FEST with WINE LIPS → Wine Lips; The Hails → Hails; Graham Hunt / 9Million (co-headline) → Graham Hunt; JAKE MINCH - Getting Big Tour → Jake Minch. Case, punctuation and HTML entities were normalized. No spelling or date guesses were accepted. Retain complete artwork without cropping.

## Coverage and limits

32 of 47 canonical Rickshaw shows dated October 24, 2026 onward have validated artwork in this repair. The following 15 remain unresolved; absence of an accepted entry does not mean no image exists:

| Date       | Canonical show                  | Reason                                                                 |
| ---------- | ------------------------------- | ---------------------------------------------------------------------- |
| 2026-10-24 | Country Risqué (record release) | No matching current official calendar listing                          |
| 2026-10-27 | Otha                            | Linked ticket page is queued; calendar shows Violet Grohl on this date |
| 2026-11-08 | Forrest Nolan                   | Ticketmaster access restriction                                        |
| 2026-11-15 | Francisca Valenzuela            | Official ticket evidence not recovered                                 |
| 2026-12-05 | Alison's Halo                   | Official ticket evidence not recovered                                 |
| 2026-12-08 | Bree Runway                     | Current official ticket date is January 21, 2027; artwork withheld     |
| 2026-12-09 | Jessica Lea Mayfield            | Official listing explicitly cancelled; artwork withheld                |
| 2027-01-07 | Chris Simpson                   | Linked ticket page queued                                              |
| 2027-01-09 | Super Greens                    | Exact January ticket evidence not recovered; July listing rejected     |
| 2027-01-15 | Seb Lowe                        | Linked ticket page queued                                              |
| 2027-01-18 | Tara Clerkin Trio               | Official ticket evidence not recovered                                 |
| 2027-02-19 | Small Brown Bike                | Linked ticket page queued                                              |
| 2027-02-20 | Starman SF                      | Official ticket evidence not recovered                                 |
| 2027-02-24 | Radio Free Alice                | Official ticket evidence not recovered                                 |
| 2027-03-26 | Sadurn                          | Official ticket evidence not recovered                                 |

## Verification

All 32 images returned successful HTTPS responses with recognized JPEG/PNG/WEBP/GIF signatures. The normal serialized ETL exported all 32 associations. All 4,867 canonical event objects are unchanged except artwork; shared-ledger revision remains `159fd36b8ae92e0c664ef1995b3d0a8afe7e4d4a7b9cf1186555299a2ee918f1`. Encrypted recovery snapshot verified and unchanged. Artist/venue upcoming summaries and indexes were refreshed by ETL at the current time.

The initial atomic directory replacement failed with Windows EPERM while Vite was watching the output. The previous dataset was restored. Closing Vite, repeating ETL, then restarting Vite succeeded. Existing ETL warnings remain: one stale non-Rickshaw poster (734712249) and two cross-year duplicate event groups; no canonical repair was made here.

Focused artwork tests passed (32 tests). Local browser and production frontend build verification are recorded in PR #137. This is a local/export repair, not a production publication receipt.
