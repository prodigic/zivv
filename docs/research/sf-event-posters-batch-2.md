# SF show artwork research — batch 2

Checked 2026-10-10. Input: 16 venues, 219 listed events. Output: **152 exact matched records**, including 4 posters and 148 event-artwork records. All retained image URLs returned successful HTTPS responses with JPEG/PNG/GIF/WEBP file signatures. No app, registry or public-data edits. Parent owns integration and audit.

This batch differs from other venue batches; its counts are not an apples-to-apples model quality benchmark. Token or dollar usage was not measured.

## Method and verification

Batched public HTTP fetches per venue, saved HTML/JSON under `.cache/sf-poster-b2*`, extracted JSON-LD, calendar cards, official event links and og:image. Matched input event IDs to current public event records to recover canonical headliner IDs and dates. Calendar card names use conservative punctuation/case normalization; short canonical names such as L7 and MPH are allowed only on the exact date. No fuzzy spelling matching. Rescheduled/cancelled/moved GAMH cards excluded.

The final eventUrl is the observed show-specific outbound link where available, per parent instruction. Many AXS/Seetickets ticket-detail links return automation 403 even though the official source calendar is open with exact event/date/image evidence. Evidence records the opened calendar or JSON source. No retained row uses a generic calendar as its eventUrl. A 403 ticket page is not reported as a verified 200 event-detail page.

Seetickets CDN serves real WEBP bytes with incorrect application/x-www-form-urlencoded MIME. Verification uses file signatures; response headers alone initially undercounted valid images. Every retained image was subsequently checked by bytes. The image check ledger is `.cache/sf-poster-b2-image-checks.json`. Photographs/promotional graphics are event-artwork; DNA flyer paths and Mab explicit poster evidence are labelled poster.

## Venue coverage

| Venue | Listed | Matched | Remaining | Source |
|---|---:|---:|---:|---|
| Great American Music Hall | 59 | 45 | 14 | [official site](https://gamh.com/) |
| Fillmore | 49 | 31 | 18 | [official site](https://www.thefillmore.com/visit) |
| Regency Ballroom | 42 | 33 | 9 | [official site](https://www.theregencyballroom.com/faq/) |
| Warfield | 25 | 15 | 10 | [official site](https://www.thewarfieldtheatre.com/) |
| Masonic Center | 17 | 10 | 7 | [official site](https://www.livenation.com/venue/KovZpZAJ6nlA/the-masonic-events) |
| Hotel Utah Saloon | 10 | 7 | 3 | [official site](https://hotelutah.com/) |
| 4 Star Theater | 5 | 4 | 1 | [official site](https://www.4-star-movies.com/) |
| DNA Lounge | 3 | 3 | 0 | [official site](https://www.dnalounge.com/) |
| Palace of Fine Arts | 2 | 1 | 1 | [official site](https://www.palaceoffinearts.org/contact) |
| Eagle Tavern | 1 | 0 | 1 | [official site](https://sf-eagle.com/) |
| the New Farm | 1 | 0 | 1 | [official site](https://www.thenewfarmsf.org/) |
| the Bandshell | 1 | 1 | 0 | [official site](https://sfrecpark.org/870/Golden-Gate-Park---Bandshell) |
| the Chapel Outdoor State | 1 | 1 | 0 | [official site](https://thechapelsf.com/contact/) |
| Undergarden | 1 | 0 | 1 | No supplied official site |
| the Mabuhay Gardens/on Broadway | 1 | 1 | 0 | [official site](https://themab.org/) |
| Goorin Headquarters | 1 | 0 | 1 | No supplied official site |

### Great American Music Hall

Opened official calendar and all six list pages via published Seetickets AJAX action/nonce. 2027 January-March cards checked against monthly calendar and weekday. Ticket detail pages return 403. Skipped rescheduled Divine Offering and moved Julia Wolf; other gaps are support-act/headliner changes, descriptive or misspelled names, and missing dates. No automatic name repair.

Unresolved listed events:

- 1566253400: 2026-10-09-phillip-phillips-great-american-music-hall
- 790147991: 2026-10-11-divine-offering-tribute-great-american-music-hall
- 326858952: 2026-10-11-sita-michelle-coltrain-great-american-music-hall
- 849801487: 2026-10-19-amantes-del-futuro-great-american-music-hall
- 1611382547: 2026-10-22-automelodi-great-american-music-hall
- 410173558: 2026-10-23-julia-wolf-great-american-music-hall
- 433098467: 2026-10-23-dj-trst-great-american-music-hall
- 538134950: 2026-10-30-cold-cave-solo-great-american-music-hall
- 1965420200: 2026-11-03-madre-cumbia-great-american-music-hall
- 641371844: 2026-11-13-dj-devendra-banhart-great-american-music-hall
- 828175309: 2026-11-28-zepparella-tribute-great-american-music-hall
- 1675729823: 2026-11-30-a-john-waters-christmas-great-american-music-hall
- 714057284: 2026-12-24-oakland-interfaith-gospel-choir-two-shows-great-american-music-hall
- 1667153419: 2027-02-18-jess-wiliamson-great-american-music-hall

### Fillmore

Opened official /shows MusicEvent JSON-LD. 36 source entries yielded 31 listed matches. Later source pagination beyond this initial calendar page was not retrieved; uncovered future shows remain a pagination gap, not evidence that no artwork exists. October 9 is past and absent.

Unresolved listed events:

- 2101436706: 2026-10-09-my-morning-jacket-the-fillmore
- 974505995: 2026-12-16-young-gravy-the-fillmore
- 305077359: 2026-12-18-death-angel-the-fillmore
- 1214794765: 2026-12-19-allman-betts-family-revival-the-fillmore
- 1518222921: 2026-12-20-allman-betts-family-revival-the-fillmore
- 1396594516: 2027-01-24-tesseract-the-fillmore
- 1293864265: 2027-01-27-ibeyi-the-fillmore
- 109083181: 2027-01-28-the-california-honeydrops-the-fillmore
- 2119187022: 2027-01-29-the-california-honeydrops-the-fillmore
- 903168732: 2027-01-30-the-california-honeydrops-the-fillmore
- 310620397: 2027-02-09-rhiannon-giddens-the-fillmore
- 1945441745: 2027-02-12-michael-shannon-jason-narducy-the-fillmore
- 2069514992: 2027-02-13-michael-shannon-jason-narducy-the-fillmore
- 1828128754: 2027-02-23-jack-white-the-fillmore
- 763943814: 2027-02-25-spin-doctors-the-fillmore
- 706381703: 2027-04-02-grateful-shred-the-fillmore
- 1370827640: 2027-04-03-grateful-shred-the-fillmore
- 2042063808: 2027-05-06-french-79-the-fillmore

### Regency Ballroom

Opened /shows, then its observed data-file AEG JSON, 41 dated records. Exact local date/performer/venue match; event-media only. Bleood, November 6 Lucy Bedroque, Headache and Manic Street Preachers have empty media objects in that feed. Other gaps are past date or descriptive/misspelled labels. Ninajirachi vs Nina Jirachi is unresolved canonical-name spelling.

Unresolved listed events:

- 1225987582: 2026-10-09-the-dk-kennedys-the-regency-ballroom
- 1387481638: 2026-10-15-the-blasting-company-playing-over-the-garden-wall-the-regency-ballroom
- 1573945080: 2026-10-29-bleood-the-regency-ballroom
- 426026073: 2026-10-30-cholos-vs-vampiers-the-regency-ballroom
- 1345334767: 2026-11-06-lucy-bedroque-the-regency-ballroom
- 781305587: 2026-11-14-headache-the-regency-ballroom
- 37617756: 2026-11-16-manic-street-preachers-the-regency-ballroom
- 1063443285: 2026-11-17-nina-jirachi-the-regency-ballroom
- 712643348: 2026-11-18-nina-jirachi-the-regency-ballroom

### Warfield

Opened calendar and /events/all, plus discovered detail pages. Show title, displayed date, SF street address and og:image were matched. Uncovered shows did not match retrieved links or lie beyond retrieved calendar listing; no absence-of-artwork claim.

Unresolved listed events:

- 896523095: 2026-10-24-fakemink-the-warfield
- 2124994044: 2026-11-08-henry-lau-the-warfield
- 1029472319: 2026-11-19-roz-the-warfield
- 231484990: 2026-12-03-roa-the-warfield
- 504788436: 2026-12-05-berner-the-warfield
- 976270494: 2027-03-13-foil-arms-and-hog-the-warfield
- 1632555493: 2027-03-20-calema-the-warfield
- 616679665: 2027-03-23-vacations-the-warfield
- 1372971827: 2027-04-20-the-warning-the-warfield
- 1053114888: 2027-05-16-valery-meladze-the-warfield

### Masonic Center

Opened sfmasonic.com/shows JSON-LD. Remaining comedy-qualified labels and Glack/Petty Wap did not exactly match source headliners. Left unresolved without artist-name repair.

Unresolved listed events:

- 1753181163: 2026-10-15-laura-ramoso-comedy-the-masonic
- 1402381226: 2026-10-16-laura-ramoso-comedy-the-masonic
- 1835129024: 2026-10-17-daniel-sloss-comedy-the-masonic
- 1060844080: 2026-10-27-glack-the-masonic
- 322026: 2026-11-07-chelsea-handler-comedy-the-masonic
- 566269486: 2026-12-03-petty-wap-the-masonic
- 1293270479: 2026-12-11-matteo-lane-comedy-the-masonic

### Hotel Utah Saloon

Opened official calendar and matched same-card title/headliners/date/image. Official ticket details return 403. Published AJAX requests returned empty bodies. Past October 9 and misspelled Gypsy Hoeny Moon, plus 3 Oclock Rock remain gaps.

Unresolved listed events:

- 1431851118: 2026-10-09-dirty-brown-napkins-hotel-utah
- 1340030112: 2026-10-10-gypsy-hoeny-moon-hotel-utah
- 1223702351: 2026-10-25-3-oclock-rock-showcase-hotel-utah

### 4 Star Theater

Opened CinemaSF calendar-of-events and four exact music detail pages with dated JSON-LD and show promotional photography. Squarespace HTTP image properties upgraded to HTTPS only after live byte validation. Dead Beat at Dawn film label did not exactly match retrieved performer labels; unresolved.

Unresolved listed events:

- 1061834252: 2026-10-29-dead-beat-at-dawn-film-815pm-4-star-theater

### DNA Lounge

Opened archive, October 2026 monthly calendar, and all three discovered exact show pages. Flyer paths and show dates verified. Echos and Drift Mothership explicitly use Above DNA within DNA Lounge; included venue complex with room distinction in evidence.

### Palace of Fine Arts

Opened official events page and The Tallest Man on Earth detail JSON-LD. Residents (playing Eskimo) descriptive headliner label not resolved; uncovered show remains an identity/label gap.

Unresolved listed events:

- 205284834: 2026-11-21-the-residents-playing-eskimo-palace-of-fine-arts

### Eagle Tavern

Opened official homepage and /events/ calendar. No exact November 12 Fast Friends card/artwork found in retrieved source. Public search did not surface a matching official show. This is an inspected-source gap, not an assertion that artwork does not exist.

Unresolved listed events:

- 1931110066: 2026-11-12-fast-friends-the-eagle

### the New Farm

Opened thenewfarmsf.org homepage/event section; no exact October 10 Voice of the Soul show artwork in retrieved HTML. Public search found a third-party listing attributed to Humma Kavula with matching lineup but no opened official show/image, so omitted.

Unresolved listed events:

- 126222165: 2026-10-10-voice-of-the-soul-the-new-farm

### the Bandshell

Opened SF Recreation and Parks venue page; identified Bay Beats as SF Public Library presenter through public event search. Opened official SFPL October 24 event page, exact Bandshell and 5pm Skip the Needle lineup, same-event hero image.

### the Chapel Outdoor State

Opened official contact page and calendar. Exact October 18 Travie Bobbito card states The Chapel Outdoor Stage. Input State is a spelling error; evidence records Stage and exact outdoor venue. Observed Seetickets event link retained.

### Undergarden

No supplied official website. Searched exact Moosetrout/Undergarden date; only source-list result with message bands for location surfaced. Official venue/artist event page and working artwork remain unidentified. Do not characterize as no-artwork.

Unresolved listed events:

- 953185690: 2026-10-23-moosetrout-the-undergarden

### the Mabuhay Gardens/on Broadway

Opened themab.org homepage/events and discovered exact Knights of Molino record release detail page. November 6, Mabuhay Gardens, 435 Broadway, explicit same-page event-poster alt text. Used observed responsive WEBP image rather than potentially stale JSON-LD image.

### Goorin Headquarters

No supplied official website. Searched exact venue, American Dream and October 17 combinations; no verified official matching event/image surfaced. Private/company-event identity remains unresolved. Do not characterize as no-artwork.

Unresolved listed events:

- 2082002351: 2026-10-17-the-american-dream-goorin-headquarters

## Audit notes

Independently sample exact date/headliner/venue and image identity from original pages; include negative results and the 2027 GAMH calendar cards. Explicit identity cases requiring review: Chapel Outdoor State/Stage, Mabuhay/on Broadway at 435 Broadway, and Above DNA room. The gap inventory intentionally preserves descriptive and spelling inconsistencies rather than silently repairing canonical artist records.
