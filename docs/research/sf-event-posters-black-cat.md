# Black Cat rendered-calendar follow-up

On 2026-10-10 the parent opened the [official ticket calendar](https://blackcatsf.turntabletickets.com/calendar)
in a browser and followed its Shows link. Its rendered show cards expose complete
2026 dates in accessible link names, individual show links, performer titles and
images together. This resolves the earlier static HTML loading-shell limitation.

Eight of ten catalog events match the displayed date and performer: Benito
Gonzalez on October 10; Joe Warner/Soul Sessions on October 14, October 21,
October 28 and November 4; Joe Block solo on October 15; Joe Block quintet on
October 16; and NO(w) Beauty on October 22. Descriptive billing remains unchanged
in the catalog. Each image was then fetched successfully over HTTPS and checked
for an image signature. Artwork is conservatively classified as event artwork.

October 9 is past and absent from the inspected upcoming list; no December 12
Dragon Force match was established. These gaps are not claims of no artwork.
Observed rendered cards: `.cache/blackcat-rendered-cards.json`; candidate matches:
`.cache/sf-poster-results-5.json`. The stronger-model sample audit is required
before the new matches are accepted.
