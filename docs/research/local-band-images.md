# Local band image research

Checked October 10, 2026. The image-source audit now covers the entire 526-name public local-artist catalog, including artists without upcoming shows. Every entry has a documented research outcome; photo coverage remains incomplete.

## Coverage

| Result                                           | Artist records |
| ------------------------------------------------ | -------------: |
| Visually reviewed photo found                    |            303 |
| Image candidate needs further review             |             16 |
| Combined artist identity needs resolution        |              3 |
| Only logos, artwork or nonperformer images found |             94 |
| No attributable photo found in the checked pages |             83 |
| Sources unavailable                              |             27 |
| Not researched                                   |              0 |
| Total                                            |            526 |

303 records share 276 distinct selected images. Annotated billing names such as “5pm” and “record release” retain their original IDs and explicitly reference the base artist research. Counts refer to catalog records, not 526 unique musical acts. There are 290 records with exported upcoming shows and 236 without. The remaining 223 records are clearly marked in the gallery; “no photo found” is limited to the sources checked, not a claim that no photograph exists anywhere.

## Browse and data

- [Searchable photo gallery](local-band-image-gallery.html): search names and filter by photo outcome or show availability.
- [Full structured catalog](local-band-image-catalog.json): stable IDs, exact names, selected image and source links, rejected candidates, identity evidence, credits, usage terms, source attempts, and image URL validation.
- [Initial priority research](local-band-image-sources-priority.md) and [press-source research](local-band-image-sources-press.md).
- Full-catalog source batches [1](local-band-images-batch-1.md), [2](local-band-images-batch-2.md), and [3](local-band-images-batch-3.md).
- [Bandcamp profile audit](local-band-images-bandcamp.md), followed by the [62-record alternate-source pass](local-band-images-bandcamp-fallback.md).
- [Annotated records without an exact base artist](local-band-images-additional.md) and [Shoplifters United supplemental source](local-band-images-supplemental.md).
- [Original-resolution image links](local-band-image-originals.json): 12 replacements copied from the same reviewed profile image's original-image popup link.

Each research batch has a matching JSON file.

## Inventory and identity safeguards

The public local-artist and exclusion lists define the scope. 524 entries match exact exported artist names. Two additional punctuation/whitespace mismatches are recorded explicitly: “Marty O'Reilly Trio” maps to artist 471740585, “Marty O' Reilly Trio”; “Shoplifters United (tribute” maps to artist 1307419795, “Shoplifters United (tribute)”. The research does not modify IDs, classifications, the shared ledger, or app data.

The [Sleep Bandcamp page](https://sleepband.bandcamp.com/) is a Melbourne namesake and is rejected. [Third Man Records](https://thirdmanrecords.com/collections/sleep) identifies the intended San Jose band, and [Pitch Perfect PR](https://www.pitchperfectpr.com/sleep) provides the selected Travis Shinn photograph. The prior locality-source claim is flagged for separate data repair. Other ambiguous combined bills and namesake matches remain unselected.

## Photo types and reuse

Selected images include band portraits, concert photos, individual artists or bandleaders, photographic collages, and archival lineups. These distinctions remain in the notes; a solo portrait is not presented as a photograph of an entire trio or orchestra. Logos, album art and unrelated people are not silently promoted to performer photos.

Most reuse terms are unknown. A public artist, venue or press page does not itself grant permission. Credits are recorded when stated; unknown credits remain unknown. The [Avengers photograph](https://commons.wikimedia.org/wiki/File:The_Avengers.JPG), by Robman94, has an explicit [CC BY-SA 3.0 license](https://creativecommons.org/licenses/by-sa/3.0/). It depicts a 2012 performance; retain attribution, source/license links, identify changes and follow the stated adaptation terms.

## Verification and delivery boundary

All 276 distinct selected image URLs returned HTTP 200 with image content types during the final checks. Per-image check timestamps are stored in the catalog. Three images needed a GET response-header check after unusual HEAD responses; image bytes were not saved. Visually inspected images through remote-image browser contact sheets, checked gallery filters, validated complete unique-ID coverage and exact names, and independently audited selected photos, credits and alias mappings.

Social CDN URLs may expire; archived or resized photos may need a fresh source copy when approved for production. This is a research gallery and source inventory. Photos have not been integrated into the live Zivv application.
