# Venue city corrections

Researched October 1, 2026. These findings support correcting malformed city fields in the venue directory. City verification uses venue, municipal, operator, or event organizer sources. Addresses are retained separately from city names; a street number is never a city.

## User-reported venues

| Venue / current ID | Verified city | Address and evidence |
| --- | --- | --- |
| Mabuhay Gardens / 1419356603 | San Francisco | The [venue website](https://themab.org/) lists Mabuhay Gardens / On Broadway at 443 Broadway, San Francisco, and also advertises performances at 435 Broadway. Both addresses are in San Francisco; retain the event's particular room/address. |
| Gray Area / 2036943294 | San Francisco | 2665 Mission Street, San Francisco, stated in the [venue FAQ](https://grayarea.org/faq/). |
| Feinstein's at the Nikko / 89847210 | San Francisco | 222 Mason Street, San Francisco, stated on the [venue homepage](https://www.feinsteinssf.com/). |
| Paramount Theatre / 1275253527 | Oakland | 2025 Broadway, Oakland, stated in the [venue website footer](https://www.paramountoakland.org/sitemap). |

## Additional malformed cities

| Venue / address discriminator | Verified city | Primary evidence and correction notes |
| --- | --- | --- |
| Spats / 134509849 | Berkeley | The [City of Berkeley landmarks staff report](https://berkeleyca.gov/sites/default/files/documents/2025-01-06_LPC_Item%207_1900-Blk%20Shattuck_Staff%20Report%20and%20Attachments.pdf) identifies Spats as operating at 1974–78 Shattuck Avenue. The city's [housing inventory](https://rentboard.berkeleyca.gov/sites/default/files/documents/2022-11-01_BerkeleyHEU_Combined_Web.pdf) lists 1974 Shattuck's current use as Spats. Correct source spelling `Shattack` to `Shattuck` where needed. |
| Rain Dog Records / 1953779877 | Petaluma | 1010 Petaluma Boulevard North, Petaluma, stated on the [venue location page](https://www.raindogrecords.net/location/). |
| Tamper Room / 2124628181 | Fremont | 43737 Boscell Road. The [City of Fremont business bulletin](https://content.govdelivery.com/accounts/CAFREMONT/bulletins/34f06ae) identifies Tamper Room at this address among Fremont businesses. |
| Waterhawk Lake Club / 2115869685 | Rohnert Park | 5000 Roberts Lake Road, Rohnert Park, stated on the [venue homepage](https://www.thewaterhawk.com/) and [venue calendar](https://www.thewaterhawk.com/calendar). |
| Lake Cunningham Skate Park / 619729370 | San Jose | 2305 South White Road, San Jose. The [city park brochure](https://www.sanjoseca.gov/home/showpublisheddocument/10309/636660882331430000) explicitly identifies Lake Cunningham Regional Skatepark and gives this park address. |
| 9 Lives Warehouse / 7650 Hawley Street | Oakland | [SOS Booking's own Whispers event page](https://www.sosbookingandproduction.com/booking/2026/7/23/whispers-corona-sekse-ls5r7-4499x-et2y5) lists 9 Lives Warehouse, 7650 Hawley Street, Oakland, CA 94621. This establishes the newer site's city/address. The older 435 23rd Avenue street address remains unverified by a primary web source in this pass; source venue data labels it Oakland. |
| Point San Pablo Harbor / 1900 Stenmark Drive | Richmond | The [harbor directions page](https://www.pspharbor.com/directions) explicitly lists 1900 Stenmark Drive, Richmond. |
| Winters Tavern / 1522 Francisco Boulevard | Pacifica | The [venue homepage](https://winterstavern.com/) lists 1522 Francisco Boulevard, Pacifica. Do not apply this city to the distinct Winters Tavern Motherlode record at 275 South Washington Street, Sonora. |
| Vets Hall / 846 Front Street | Santa Cruz | The [hall operator's homepage](https://www.veteranshall.org/revised-home-page/) states 846 Front Street, Santa Cruz. |
| Vets Hall / 549 Merchant Street | Vacaville | [DAV Chapter 84's own meeting information](https://www.cadav84.org/join-our-chapter) lists the Veterans Memorial Building at 549 Merchant Street, Vacaville. This is a separate building from the Santa Cruz Vets Hall. |
| The New Farm / 10 Cargo Way | San Francisco | The [venue homepage](https://www.thenewfarmsf.org/) states 10 Cargo Way, San Francisco. |
| The Hub / 2650 Broadway | Redwood City | The [venue homepage](https://www.thehubrwc.com/) states 2650 Broadway, Redwood City. |
| Knot Club / 1900 Stenmark Drive | Richmond | The harbor's [Knot Yacht Club page](https://www.pspharbor.com/the-knot-yacht-club) identifies the clubhouse venue; the same operator's [directions](https://www.pspharbor.com/directions) establish the harbor address as 1900 Stenmark Drive, Richmond. |
| Civic Center / 135 San Carlos Street | San Jose | The operator's [San Jose Civic technical specifications](https://sanjosetheaters.org/wp-content/uploads/2025/08/Technical-Specifications-San-Jose-Civic_August-2025.pdf) state 135 West San Carlos Street, San Jose. Use the address discriminator because Civic Center also occurs for Richmond and San Francisco in raw events. |
| Barrel Proof Lounge / 501 Mendocino Avenue | Santa Rosa | The [venue contact page](https://barrelprooflounge.com/contact-us/) states 501 Mendocino Avenue, Santa Rosa. |
| Gilman Brewing Co. / 912 Gilman Street | Berkeley | The [brewery contact page](https://gilmanbrew.com/contact/) identifies the Berkeley taproom at 912 Gilman Street. The brewery also operates a distinct Santa Cruz location. |
| Noble Cinema Studios / 1509 Solano Avenue | Vallejo | The [venue's Eventbrite organizer page](https://www.eventbrite.com/o/68231408763) advertises its own events at 1509 Solano Avenue, Vallejo. A [venue-organized event page](https://www.eventbrite.com/e/big-aves-album-release-function-noble-cinema-studios-tickets-1987088878326) states the full address. |
| The Civic / 135 San Carlos Street | San Jose | Same address as the [operator's San Jose Civic specifications](https://sanjosetheaters.org/wp-content/uploads/2025/08/Technical-Specifications-San-Jose-Civic_August-2025.pdf). Raw event `oct 10 2026 Movements ... at the Civic, 135 San Carlos St., San Jose` supports identifying this record with San Jose Civic. |
| Biscuits and Blues / 401 Mason Street | San Francisco | The [venue menu/contact page](https://www.biscuitsandblues.com/menu) states 401 Mason Street, San Francisco. |
| Apple Jacks Bar / 8790 La Honda Road | La Honda | The [venue's own history/contact page](https://applejacksbar.com/history.html) states Apple Jack's Inn, 8790 La Honda Road, La Honda. |
| SF Building Resources / 701 Amador Street | San Francisco | The [organization contact page](https://buildingresources.org/contact/) states 701 Amador Street, San Francisco. |
| Bay Area Makers Farm / 2700 Barbers Point Road | Alameda | The [organization's contact page](https://bayareamaker.farm/get-involved) states 2700 Barbers Point Road, Alameda. Its official name is Bay Area Makerfarm. |
| Webster Park / 1435 Webster Street | Alameda | The [operator WABA's Halloween event page](https://www.westalamedabusiness.com/howloween) states Webster Park, 1435 Webster Street, Alameda. |
| Alliance Francaise / 1345 Bush Street | San Francisco | The [organization homepage](https://www.afsf.com/) states 1345 Bush Street, San Francisco. |
| 19 Broadway / 17 Broadway | Fairfax | The [Town of Fairfax's permit packet](https://storage.googleapis.com/proudcity/fairfaxca/uploads/2019/02/Item-5.17-19-Broadway-Part-1.pdf) concerns 17/19 Broadway nightclub use. The current [Mac's at 19 Broadway contact page](https://macsat19broadway.com/connect/) states 19 Broadway, Fairfax. City is verified; retain the source record's address rather than silently changing 17 to 19. The legacy `19broadway.com` domain currently serves unrelated content and should not be used as venue evidence. |

## Unresolved primary-source verification

| Venue | Local source evidence | What remains unresolved |
| --- | --- | --- |
| FML Studios / 1616660773 | `data/events.txt` contains `FML Studios, 2400 Filbert Street, Oakland` on August 8, August 21, and September 5, 2026. | Oakland is explicit in local event source text and corroborated by several external listings, but a fetchable first-party venue/organizer page establishing the address was not found. The purported official link in one directory leads to an inaccessible [Instagram post](https://www.instagram.com/p/DbgZwyoO7Rx/). Treat external primary verification as unresolved. The unrelated `fml.studio` belongs to a Calgary community consulting business. |

## Applying these findings

Recover the city from correctly delimited event locations where possible, preserving street address separately. Prefer specific address matches for generic names such as Vets Hall and Civic Center. Venue branches and rooms can share a city while remaining distinct identities. A source typo or missing city should not force an unrelated city-wide alias or erase location distinctions.

### Current venue ID mappings

These IDs were read from `public/data/venues.json` during this investigation. Their city evidence is cited in the table above.

| ID | Venue | City |
| --- | --- | --- |
| 1535527108 | 9 Lives Warehouse | Oakland |
| 1918643887 | Point San Pablo Harbor | Richmond |
| 170296881 | Winters Tavern | Pacifica |
| 564335400 | the New Farm | San Francisco |
| 1804000273 | the Hub | Redwood City |
| 747776193 | Knot Club | Richmond |
| 911158095 | Civic Center at 135 San Carlos | San Jose |
| 209605697 | Barrel Proof Lounge | Santa Rosa |
| 2086074371 | Gilman Brewing Co. | Berkeley |
| 745745800 | Noble Cinema Studios | Vallejo |
| 1414808200 | the Civic at 135 San Carlos | San Jose |
| 527022144 | Biscuits and Blues | San Francisco |
| 367184186 | Apple Jacks Bar | La Honda |
| 1075478617 | SF Building Resources | San Francisco |
| 2037432326 | Bay Area Makers Farm | Alameda |
| 165368460 | Webster Park | Alameda |
| 1829915689 | Alliance Francaise | San Francisco |
| 855121402 | 19 Broadway | Fairfax |

### Vets Hall record conflict

Venue ID `1850130272` currently combines city `549` with address `846 front Street`. Its only upcoming event is `1893495232`, Arsonists Get All The Girls on October 30, 2026. [Promoter PinUp Productions' own ticket page](https://www.eventbrite.com/e/agatg-halloween-show-the-vets-hall-in-santa-cruz-tickets-1995107709867) establishes that this performance is at 846 Front Street, Santa Cruz. The local source also explicitly states Santa Cruz for this performance.

A past September 19, 2026 Ancient Rage performance in `data/events.txt` instead states Vets Hall, 549 Merchant Street, Vacaville. Both cities are real locations verified above. Correct the current upcoming event using its own evidence, and preserve the ability to distinguish the Vacaville building during future ingestion. A name-only city alias would merge distinct halls.
Venue metadata corrections now use `data/venue-location-corrections.json`, guarded by existing venue ID and name. The export reapplies these reviewed fields even when the operator ledger predates the review. Imports also load the corrections before reconciling incoming events. FML Studios uses explicit Oakland locations in retained `data/events.txt`; its external primary-source verification remains open.

Civic Center ID `911158095` also combines past Richmond/San Francisco events with San Jose events. No city-wide metadata correction is applied to this mixed record. It and the Vets Hall conflict require an event-level split before their legacy metadata can be corrected safely.

## HopMonk repair and operator handoff

The parser now resolves HopMonk aliases within the source city, producing separate `Hopmonk Tavern (Novato)` and `Hopmonk Tavern (Sebastopol)` identities. The current catalog repair moved 101 explicitly matched events, preserving event IDs, URLs, original observations, and first-added dates. One past September 4 event (`1836374258`) has no matching retained source row and remains unresolved.

Run these commands in the private operator checkout before its next export:

```powershell
npm run build:etl
node scripts/repair-hopmonk.js
node scripts/repair-hopmonk.js --apply
node scripts/run-etl.js
```

The first repair command reports changes without writing the ledger. The apply command holds the ingestion lock, writes `data/ingestion/reports/hopmonk-city-repair.json`, and saves the ledger atomically. Repeating the repair leaves corrected events unchanged. The private ledger and audit report remain outside version control.

The checked public export contains 4,320 events, matching the prior export. Its event IDs, slugs, first-added fields, and source observations are unchanged. Venue and artist upcoming summaries were refreshed for October 1, 2026.
