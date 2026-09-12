# Wider San Francisco venue investigation

Investigated **2026-09-07**. Three subagents ran with **gpt-5.6-luna / high**: major venues, clubs, and other music/performance spaces. The coordinator reviewed their findings and investigated four additional groups. This broad pass extends the [Fillmore, Rickshaw Stop and Bottom of the Hill study](venue-source-investigation.md).

The deliverable is a source map and importer requirements. No shows were imported, no daily job was enabled, and no venue aliases were merged. A verified source here means its identity and a useful public listing were observed; it does **not** mean an adapter has passed exhaustive coverage testing. Search/browser renderings can also be cached. Counts and month horizons are observations from this pass, not a synchronized live census.

## Findings that change the implementation plan

1. **Reuse parsers, with per-venue configuration.** Many official calendars expose ordinary HTML cards and TicketWeb or See Tickets links. Start with reusable list/detail extraction and pagination, then configure each venue's selectors and room filters. A shared ticket provider does not establish a shared page structure or exhaustive provider coverage. Evidence: [major venue report](research/sf-major-venues.md), [club report](research/sf-club-venues.md).
2. **Venue identity must precede SF filtering.** The checked-in generated dataset has malformed city fields, duplicate names, address conflicts and separate rooms. A filter on `city === San Francisco` misses legitimate SF venues. Amoeba's SF-labeled record contains the Berkeley address; do not attach the SF website to that ID automatically. Chase Center also has unresolved historical aliases. Evidence: [other venues report](research/sf-other-venues.md) and the candidate inventory below.
3. **One date can contain several performances.** Black Cat has early/late sessions; Public Works can have several cards on one day; DNA/Above DNA and Chapel/Outdoor Stage require room-aware matching. Use provider occurrence/session identity where available. A title/date fingerprint is a matching aid, not a permanent event ID. Evidence: [club report](research/sf-club-venues.md), [additional venues report](research/sf-additional-venues.md).
4. **Moves and ticket state are first-class data.** August Hall, Chapel, Bimbo's, Castro and Civic expose relocation/status notices. Preserve cancellation, postponement, destination venue, sold-out, presale and waitlist separately. A source disappearance cannot by itself mean cancellation. Follow an explicit move to the destination source and retain the same canonical event and original date added. Evidence: [major venue report](research/sf-major-venues.md).
5. **Define event scope explicitly.** Calendars mix concerts with DJs, comedy, films, art, yoga, drag, open mics and community events. Preserve source categories and route uncertain entries to review; do not turn party titles into artist names. Suggested pilot scope is live music, with DJ/open-mic/jam policies recorded separately. This is a proposed product rule, not an approved expansion of Zivv's music scope. Evidence: [other venues report](research/sf-other-venues.md), [Public Works](research/sf-additional-venues.md#public-works-sf).
6. **Partial sources must remain visible as gaps.** DNA retrieval was robots-blocked, Music City's linked Eventbrite organizer returned 429, and several calendars returned loading shells. Peacock lacked concrete dated listings; Thee Parkside's banner raises an operating-status question. These observations must produce partial/review coverage rather than a successful zero-show import. Evidence: [club report](research/sf-club-venues.md), [other report](research/sf-other-venues.md), [additional report](research/sf-additional-venues.md).

## Token-efficient daily behavior

The target remains **zero model tokens on routine successful runs**. HTTP requests, HTML/JSON/ICS parsers and identity reconciliation run in code. Do not send complete websites or the full event database to a model each day.

- Fetch each distinct calendar once per run, even when it serves multiple rooms. Split records by verified venue/room afterward. Walk every advertised page or date window needed for the configured coverage horizon; a home-page preview is insufficient.
- Use conditional requests only where supported and measured. Otherwise compare normalized content hashes. Cache page/detail responses and extracted records with parser version; an unchanged response is reusable only if the prior parse was valid.
- Fetch event details for new or changed records, plus a bounded scheduled status recheck when status is absent from the list. Normalize tracking links while retaining provider-specific IDs. Never discard identity-bearing fragments such as Salesforce ticket instance hashes.
- Produce per-source coverage evidence: fetched pages/months, horizon, source occurrences, accepted matches, new candidates, exclusions with reasons, unresolved records, and fetch/parse failures. Reconcile the complete set inside that declared window. A headline count alone cannot prove completeness.
- Run an occasional deeper calendar/provider comparison, but treat third-party absence as inconclusive. Sources may share the same upstream inventory. Limit completeness claims to what the audited sources publish.
- Send only small, changed, ambiguous records to an optional model fallback under daily token/call limits. Retain evidence and cache the decision. Stop automatic acceptance when the budget or confidence requirement is unmet; continue deterministic sources and report the gap.

No defensible daily HTTP/token/runtime estimate was measured across this wider pass. Record requests, bytes, changed records, model tokens, latency and unresolved candidates during pilot runs; do not extrapolate a fixed cost from these bounded web checks.

## Date added and weekly new shows

The [daily import plan](daily-venue-import-plan.md) remains authoritative: preserve immutable `createdAtEpochMs` as the Zivv date added, keep the original value across daily/weekly reconciliation, and filter latest lists by an explicit timestamp window. A Tuesday daily import therefore remains eligible for that week's weekly edition even when Friday's source sees an existing database row.

Keep source announcement time separate and nullable. A calendar's performance date, page-update time, RSS revision or an undated announcement sidebar is not evidence of first announcement. Where only Zivv's first-seen date is known, label the section **Just added** or **Added this week**; do not claim the venue announced it that week. Seed historical rows without flooding latest lists. Replays, moves, spelling corrections and changed ticket status must not reset date added.

## Suggested next pilot

Expand the initial three to ten: **Bottom of the Hill, Rickshaw Stop, Fillmore, Brick & Mortar, Chapel, Great American Music Hall, Neck of the Woods, Knockout, SF Eagle, and Public Works**. This samples HTML/RSS, paginated ticket-provider calendars, calendar exports, session/room handling and a client-loaded source. The suggestion reflects observed extraction surfaces, not production readiness.

Before enabling each source, save representative fixtures and prove pagination exhaustion, field extraction, room mapping, stable matching, scope decisions, failed-fetch behavior and weekly date-added retention. Begin with the deterministic HTML sources; keep unresolved sources disabled. Calendar export links must be followed and validated before claiming a feed exists. Cache validators measured at Bottom of the Hill do not establish support elsewhere.

## Inventory and remaining SF scope

The [candidate inventory](../data/research/sf-venue-inventory.json) records the original venue row and generated IDs used for discovery. It is derived from **75 source rows with an explicit SF marker**, plus unmatched generated records among **65 SF-labeled rows**, yielding **103 candidate groups**. These are not 103 verified operating businesses: aliases, rooms, outdoor sites, historical entries and corrupt records remain.

Of the 75 source-row groups, **41** have at least one matching generated row whose city is not recognized as SF. All 75 had a name/alias candidate; that match does not certify identity. The comparison uses checked-in dataset version **2026-08-22T01:09:30.583Z**, not a live database snapshot. The inventory flags research matches and leaves the remaining candidates as a backlog. It is not proof that every possible SF venue has been discovered.

Remaining discovery includes smaller clubs and bars, performing-arts spaces, outdoor sites and historical records. Resolve operating status and official SF address before adding each source. Avoid querying social accounts or buying access simply because a public calendar is absent.

## Artifacts and interpretation

- [Major venues](research/sf-major-venues.md) / [records](../data/research/sf-major-venues.json): Luna/high.
- [Clubs](research/sf-club-venues.md) / [records](../data/research/sf-club-venues.json): Luna/high; Above DNA is recorded separately.
- [Other venues](research/sf-other-venues.md) / [records](../data/research/sf-other-venues.json): Luna/high.
- [Additional venues](research/sf-additional-venues.md) / [records](../data/research/sf-additional-venues.json): coordinator.
- [Source registry](../data/venue-sources.json): all entries remain disabled. The research shards preserve uncertain mappings that cannot safely receive a primary source-registry venue ID.

`venueIds` in a research record means candidates examined together, not aliases approved for merging. `primaryVenueId`, where supplied, identifies the proposed existing row; it is not permission to rewrite sibling IDs. Provider website venue numbers, organizer IDs and API IDs have distinct namespaces. An optional registry `verificationStatus` describes this research, while `onboardingState` records the remaining gate. Neither implies successful unattended ingestion.

Follow-up work remains tracked by VI-1 through VI-7 in the daily import plan: identity/date-added first, pilot adapters and completeness fixtures next, scheduler/publication after validation. `bd` is unavailable in this environment; no Beads issues were created or changed.

<!-- RESEARCH_SUMMARY -->

## Coverage summary

39 additional venue/room research records: 20 verified, 18 partial, 1 unverified. Together with the original three, there are 42 investigated records (41 venue groups, with Above DNA recorded separately). The registry now contains 36 disabled source entries; 6 additional records remain research-only because a primary mapping was not selected.

Of the 103 inventory candidates, 46 match an investigated ID and 57 remain in the discovery backlog. These candidate counts overlap aliases and are not business counts.

| Venue or room | Research status | Official calendar / website |
| --- | --- | --- |
| The Independent | verified | [Calendar](https://www.theindependentsf.com/event/) |
| Great American Music Hall | verified | [Calendar](https://gamh.com/calendar/) |
| The Chapel SF / The Chapel Outdoor Stage | verified | [Calendar](https://thechapelsf.com/calendar/) |
| August Hall | verified | [Calendar](https://www.augusthallsf.com/calendar/) |
| Bimbo's 365 Club | verified | [Calendar](https://bimbos365club.com/shows/) |
| The Regency Ballroom | verified | [Calendar](https://www.theregencyballroom.com/shows/) |
| The Warfield | verified | [Calendar](https://www.thewarfieldtheatre.com/events) |
| The Masonic | partial | [Calendar](https://www.sfmasonic.com/shows) |
| Café du Nord | verified | [Calendar](https://cafedunord.com/calendar/) |
| Swedish American Hall | partial | [Calendar](https://cafedunord.com/calendar/) |
| The Castro Theatre | verified | [Calendar](https://thecastro.com/calendar/) |
| Bill Graham Civic Auditorium | verified | [Calendar](https://billgrahamcivic.com/calendar/) |
| DNA Lounge | partial | [Calendar](https://www.dnalounge.com/calendar/) |
| Above DNA Lounge (separate room alias) | unverified | [Calendar](https://www.dnalounge.com/calendar/) |
| Kilowatt | partial | [Calendar](https://kilowattbar.com/events) |
| The Knockout | verified | [Calendar](https://theknockoutsf.com/events-2-1) |
| Neck of the Woods | verified | [Calendar](https://www.neckofthewoodssf.com/) |
| The Hotel Utah Saloon | verified | [Calendar](https://hotelutah.com/calendar/) |
| El Rio | partial | [Website; calendar unresolved](https://www.elriosf.com/) |
| SF Eagle | verified | [Calendar](https://sf-eagle.com/events/list/) |
| Make Out Room | verified | [Calendar](https://www.makeoutroom.com/calendar.html) |
| Black Cat | verified | [Calendar](https://blackcatsf.turntabletickets.com/calendar) |
| The Great Northern | partial | [Calendar](https://www.thegreatnorthernsf.com/) |
| The Midway SF | partial | [Calendar](https://themidwaysf.com/events/) |
| 4 Star Theater | partial | [Calendar](https://www.4-star-movies.com/calendar-of-events) |
| The Lab | partial | [Calendar](https://www.thelab.org/) |
| The Lost Church - San Francisco | partial | [Calendar](https://thelostchurch.org/san-francisco/) |
| Thrillhouse Records | partial | [Calendar](https://thrillhouserecords.com/pages/calendar) |
| Peacock Lounge | partial | [Calendar](https://sfpeacock.org/events/) |
| The Plough and Stars | verified | [Calendar](https://theploughandstars.com/) |
| Amoeba Music - San Francisco | partial | [Calendar](https://www.amoeba.com/live-shows/upcoming/) |
| 1015 Folsom | verified | [Calendar](https://1015.com/#calendar) |
| Palace of Fine Arts Theatre | partial | [Calendar](https://www.palaceoffinearts.org/events) |
| Chase Center | partial | [Calendar](https://www.chasecenter.com/events/) |
| Stern Grove Festival | partial | [Calendar](https://www.sterngrove.org/lineup2026) |
| Brick & Mortar Music Hall | verified | [Calendar](https://www.brickandmortarmusic.com/calendar/) |
| Public Works SF | verified | [Calendar](https://publicsf.com/calendar/) |
| Music City Starfactory | partial | [Calendar](https://www.eventbrite.com/o/music-city-san-francisco-12803819712) |
| Thee Parkside | partial | [Website; calendar unresolved](https://www.theeparkside.com/) |

Research-only mappings: The Castro Theatre; Above DNA Lounge (separate room alias); 4 Star Theater; Amoeba Music - San Francisco; Chase Center; Stern Grove Festival.
