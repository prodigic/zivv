# Manual venue map locations

Checked 2026-10-02. Researched 72 IDs:64 cited locations (site or area),8 deliberate nulls. Results are in `data/research/venue-maps/manual-locations.json`; separate IDs for proven spelling aliases are preserved. Numbered-address Census batch and its follow-up are owned by the coordinating agents. Ferry Building 595294036 is deliberately excluded here to avoid duplicate ownership.

Official identity/address evidence comes from `data/venue-details.json` and fresh operator/city/university reads. Shoreline publishes GeoCoordinates in owner metadata. SF RecPark map pin labels are base64-encoded DMS; the pin label was decoded instead of copying the shifted map viewport center. Cal Performances links a named Zellerbach map; Mountain Play links its Cushing Memorial Amphitheater map. Yerba Buena metadata identifies the Great Lawn, rather than the distinct Children’s Garden. Moscone publishes a generic EventVenue point; it is retained only as a complex area.

OpenStreetMap sources were read as vector XML using `https://api.openstreetmap.org/api/0.6/map?bbox=...` and node/way/relation endpoints. Intersections use a node shared by the two named streets. Some streets have multiple carriageway nodes; each chosen point lies in the named intersection and has area precision. Named park/building extents use the explicitly documented bounding-box center of the complete mapped feature, also labeled area. Mapcarta pages explicitly attributing their coordinate data to named OSM features supply the remaining park-area references. No public Nominatim requests or raster tile fetches were used.

Area pins represent festival access intersections, park grounds, campus buildings or a shared complex. They do not identify an exact stage, gate, floor or private home. The combined Broadway IDs use the mapped Broadway Studios complex after [owner evidence](https://themab.org/) explicitly identifies 435&443 Broadway and upstairs/downstairs rooms; their street-address ambiguity remains unchanged. [Depot’s operator](https://asi.sfsu.edu/the-depot) locates it in the lower level of Cesar Chavez Student Center; the mapped building area does not imply a specific entrance. [Levi’s Plaza management](https://www.levisplaza.com/about) establishes identity, while a mapped pedestrian-zone area avoids substituting a management-office address. [Golden Gate Park](https://sfrecpark.org/770/Golden-Gate-Park) has a broad park-area pin, so its several retained stages remain distinct.

| ID         | Venue                                         | Precision | Coordinate source                                                            |
| ---------- | --------------------------------------------- | --------- | ---------------------------------------------------------------------------- |
| 1673709304 | Quarry Amphitheater                           | area      | [source](https://www.openstreetmap.org/way/668326761)                        |
| 1739693421 | Shoreline Amphitheatre                        | site      | [source](https://www.shorelineamphitheatre.com/)                             |
| 882308789  | Yerba Buena Gardens                           | area      | [source](https://ybgfestival.org/)                                           |
| 374946520  | Civic Center Plaza                            | area      | [source](https://sfrecpark.org/866/Civic-Center-Plaza-Joseph-Alioto-Piazza)  |
| 778116947  | Hardly Stricty Bluegrass                      | area      | [source](https://www.openstreetmap.org/node/3713966077)                      |
| 1533734128 | Jack Kerouac Alley                            | area      | [source](https://www.openstreetmap.org/node/65305761)                        |
| 1167888962 | Park Place                                    | area      | [source](https://www.openstreetmap.org/node/4384834601)                      |
| 1303522840 | Clarion Alley Mission Stage                   | area      | [source](https://www.openstreetmap.org/node/65302921)                        |
| 1503344643 | Clarion Alley Valencia Stage                  | area      | [source](https://www.openstreetmap.org/node/12809540185)                     |
| 1512685125 | Robin Williams Meadow                         | area      | [source](https://sfrecpark.org/879/Golden-Gate-Park---Robin-Williams-Meadow) |
| 107186942  | Shoreline Amphitheaer                         | site      | [source](https://www.shorelineamphitheatre.com/)                             |
| 1931913617 | Shoreline Amphitheater                        | site      | [source](https://www.shorelineamphitheatre.com/)                             |
| 1980623387 | Shoreline Amphteater                          | site      | [source](https://www.shorelineamphitheatre.com/)                             |
| 2023698434 | Concord Skatepark                             | area      | [source](https://mapcarta.com/W 230901996)                                   |
| 1146900097 | Point Emery                                   | area      | [source](https://mapcarta.com/W 28406132)                                    |
| 507235645  | Shoreline Ampheater                           | site      | [source](https://www.shorelineamphitheatre.com/)                             |
| 427675501  | Shoreline Theater                             | site      | [source](https://www.shorelineamphitheatre.com/)                             |
| 1489670725 | Shorline Amphitheater                         | site      | [source](https://www.shorelineamphitheatre.com/)                             |
| 1873078626 | Zellerbach Hall                               | site      | [source](https://calperformances.org/visit/venues/zellerbach-hall/)          |
| 1471035891 | the Bandshell                                 | site      | [source](https://sfrecpark.org/870/Golden-Gate-Park---Bandshell)             |
| 577028098  | Rolph Street at Pomona St.                    | area      | [source](https://www.openstreetmap.org/node/2532019677)                      |
| 1291359065 | Embarcadero Plaza                             | area      | [source](https://www.openstreetmap.org/node/1723739166)                      |
| 181982577  | Willow's                                      | area      | [source](https://www.openstreetmap.org/node/65302196)                        |
| 1272982754 | Pacifica's Fogfist Parade                     | area      | [source](https://www.openstreetmap.org/node/65440909)                        |
| 1113366560 | Gouth Street Stage                            | area      | [source](https://www.openstreetmap.org/node/65312695)                        |
| 980508599  | Sub Zero Festival                             | area      | [source](https://www.openstreetmap.org/node/5872385656)                      |
| 1811760683 | corner of Park Place and Washington           | area      | [source](https://www.openstreetmap.org/node/4384834601)                      |
| 1781054735 | Ellis Street between Powell and Stockton      | area      | [source](https://www.openstreetmap.org/node/65332806)                        |
| 508217774  | Mountain Theater                              | area      | [source](https://mountainplay.org/2026-season-events/mountainvisit/)         |
| 2025029583 | Grand Avenue and Wood Street                  | area      | [source](https://www.openstreetmap.org/node/99537269)                        |
| 1620325708 | Marina Way and MacDonald Avenue               | area      | [source](https://www.openstreetmap.org/node/57855526)                        |
| 1788570251 | Grinstead Amphitheater                        | area      | [source](https://www.openstreetmap.org/way/27498206)                         |
| 1774955152 | Haight Ashbury Street Fair                    | area      | [source](https://www.openstreetmap.org/node/65327923)                        |
| 723101454  | Larkin Street at Eddy Street                  | area      | [source](https://www.openstreetmap.org/node/65354421)                        |
| 407232772  | Railroad Square                               | area      | [source](https://www.openstreetmap.org/way/699519898)                        |
| 1001737767 | Point Emery Park                              | area      | [source](https://mapcarta.com/W 28406132)                                    |
| 1340123468 | Hardly Strictly Bluegrass                     | area      | [source](https://www.openstreetmap.org/node/3713966077)                      |
| 145266702  | Post Street Fair                              | area      | [source](https://www.openstreetmap.org/node/65574516)                        |
| 818756583  | the Plaza                                     | area      | [source](https://mapcarta.com/23020886)                                      |
| 368186123  | Folsom Street Fair                            | area      | [source](https://www.openstreetmap.org/node/65317570)                        |
| 467396903  | Castro Street Fair                            | area      | [source](https://www.openstreetmap.org/node/65296324)                        |
| 315738847  | Golden Gate Park Bandshell                    | site      | [source](https://sfrecpark.org/870/Golden-Gate-Park---Bandshell)             |
| 1362359479 | S.F. Zoo                                      | area      | [source](https://mapcarta.com/30745404)                                      |
| 1879705643 | Hardly Strictly Bluegrass at Golden Gate Park | area      | [source](https://www.openstreetmap.org/node/3713966077)                      |
| 1969986404 | Dunphy Park                                   | area      | [source](https://www.openstreetmap.org/way/377542150)                        |
| 1276498217 | Stern Grove                                   | area      | [source](https://www.openstreetmap.org/node/65316139)                        |
| 1094184065 | Stern Grove Festival                          | area      | [source](https://www.openstreetmap.org/node/65316139)                        |
| 578805190  | Snow Park                                     | area      | [source](https://mapcarta.com/23139284)                                      |
| 988969630  | Michelle's                                    | area      | [source](https://www.openstreetmap.org/node/65302196)                        |
| 1602290234 | Oakland Pride                                 | area      | [source](https://www.openstreetmap.org/node/3244767454)                      |
| 1344278433 | Outside Lands                                 | area      | [source](https://www.openstreetmap.org/node/4026938895)                      |
| 1189056044 | Depot                                         | area      | [source](https://www.openstreetmap.org/relation/4793449)                     |
| 1578696718 | Levi's Plaza                                  | area      | [source](https://mapcarta.com/W 25751236)                                    |
| 1306836772 | Golden Gate Park                              | area      | [source](https://mapcarta.com/23051398)                                      |
| 822625010  | Moscone Center                                | area      | [source](https://www.moscone.com/directions-and-parking-moscone-center)      |
| 398286726  | Mabuhay Gardens (21+) and On Broadway (a/a)   | area      | [source](https://www.openstreetmap.org/node/2166014679)                      |
| 1113680004 | the Mabuhay Gardens/on Broadway               | area      | [source](https://www.openstreetmap.org/node/2166014679)                      |
| 1094129374 | Mabuhay Gardens and on Broadway               | area      | [source](https://www.openstreetmap.org/node/2166014679)                      |

Null decisions:

- 674532354 Civic Center and Market Street Parade: Combined moving Market Street parade and Civic Center celebration; no single site point represents both. Coordinates deliberately unset.
- 445731900 22nd & Bartlett: Retained SF Porchfest listing identifies 22nd/Bartlett, but opened organizer no longer supplies the corresponding porch map. No verified exact public performance site assigned.
- 713594331 Athen's: Retained SF Porchfest listing identifies a 21st Street segment and private porch alias. Opened organizer no longer supplies the corresponding porch map; private home location is not inferred.
- 1009706718 above DNA Lounge: Owner homepage confirms DNA Lounge 375 Eleventh, but no opened owner room-specific evidence identifies Above DNA’s separate access/site. Generic parent venue point is not assigned to this room.
- 1158870445 Santa Cruz Revival Church: Church event instructions use parking and footbridge access; owner’s office/property address does not establish the actual performance entrance. No coordinates assigned.
- 1367234521 Porchfest: Official San Rafael Porchfest identifies Gerstle Park neighborhood, but linked Teen Stage’s location is not established. A neighborhood-center point would obscure the specific stage.
- 1375030109 Streetlight Records: Linked events span San Jose and Santa Cruz Streetlight branches. Brand website supplies no single branch for this merged ID; no coordinates assigned.
- 1621831563 Mid Bartlett: Retained SF Porchfest listing identifies Bartlett between 21st/22nd, but opened organizer no longer supplies a corresponding porch map. Performance site remains unconfirmed.

Validation:72 unique inventory IDs;64 finite coordinate pairs within Bay Area bounds; every supported row has an HTTPS source and an explicit site/area precision; no research-pending placeholders. No application code, street-address research, ledger, or generated exports were edited by this agent.

Final address-parser gaps researched:

| ID         | Venue                          | Precision | Coordinate source                                       |
| ---------- | ------------------------------ | --------- | ------------------------------------------------------- |
| 1378636720 | Kuumbwa Jazz Center            | site      | [source](https://www.kuumbwajazz.org/contact/)          |
| 1964305801 | Kuumbwa Center                 | site      | [source](https://www.kuumbwajazz.org/contact/)          |
| 625980050  | Radium Runway                  | area      | [source](https://maps.app.goo.gl/Cf1uDAwzAWmWVpww9)     |
| 1611053286 | the Faight                     | area      | [source](https://www.openstreetmap.org/node/5175561848) |
| 929862156  | House of Rock                  | area      | [source](https://www.openstreetmap.org/way/958890213)   |
| 2038208300 | Harrison between 16th and 24th | area      | [source](https://www.openstreetmap.org/node/65317371)   |

Kuumbwa’s [operator contact page](https://www.kuumbwajazz.org/contact/) links a map embed whose named place data explicitly publishes the venue coordinates. Radium’s [operator page](https://www.radiumarts.org/radium-runway) links a map for the closest access address; the area label preserves the distinction from its outdoor stages. Faight’s [operator page](https://www.thefaight.com/about) identifies 473A/475 Haight, and primary OSM arts-centre node 5175561848 identifies The Faight Collective at 473A, separate from adjacent Sparc at 473. The [Santa Rosa planning narrative](https://santa-rosa.legistar.com/View.ashx?GUID=5DAE5F0F-33E6-40AF-8802-FE4D31051561&ID=14023115&M=F) identifies the former House of Rock property at 3410 and 3440 Industrial Drive; its named OSM building geometry provides the historical property area. [Carnaval’s operator](https://carnavalsanfrancisco.org/festival/) identifies the 17th/Harrison stage vicinity, and OSM node 65317371 supplies the intersection coordinates.

## Primary geometry audit

The coordinating researcher independently opened the seven primary OpenStreetMap ways underlying eight Mapcarta references. The final JSON now cites those direct API sources and uses their geometry bounding-box centers as area estimates. The raw primary responses are in `data/research/venue-maps/osm-primary-geometries.json`. Earlier source-table references are retained as research history. The complete registry/catalog contains the final primary sources. Golden Gate Park is a broad park-area estimate, not a stage or festival entrance.
