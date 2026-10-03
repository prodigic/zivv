# Thirteen single-tile treatments

Question: what could the combined show and venue-map tile look like, including
transparent surfaces and wallpaper? The user requested seven experiments,
then favored 2, 4 and 6 and requested six more. Studies 8–13 explore two
descendants of each favorite.

These are throwaway design studies on `codex/prototype-venue-treatments`, based
on the reviewed combined tile at `1ae04ca`. No treatment has been selected for
production. The existing sidebar, show navigation, venue list and artist cards
remain present so each idea can be judged in the real application.

## Run and compare

```text
npm run prototype:venue-tiles
```

If npm is unavailable, run `node scripts/prototype-venue-tiles.js`.
The command builds into `.cache/prototype-venue-tiles` and serves port 5176.
It does not replace the current production preview in `dist/` on port 5175.

[Open the studies](http://127.0.0.1:5176/zivv/events/2026-10-06-the-menzingers-great-american-music-hall?variant=8).
The floating bar selects 1–13 in two rows; its arrows and keyboard left/right arrows cycle
through the treatments. The selected `?variant=` remains shareable and stable
on reload. Input fields keep their normal keyboard behavior.

| Study | Treatment         | Idea                                                                        |
| ----- | ----------------- | --------------------------------------------------------------------------- |
| 1     | Clean Split       | Restrained shared surface, compact type, map on the right.                  |
| 2     | Transparent Atlas | The real map becomes wallpaper behind floating text.                        |
| 3     | Night Glass       | Transparent glass on luminous abstract wallpaper, with an arched map.       |
| 4     | Gig Poster        | Acid-yellow poster, emphatic condensed type, angled map sticker.            |
| 5     | Editorial         | Warm paper, serif title, oversized day and generous map.                    |
| 6     | Transit Strip     | Map as a full-height left rail, itinerary on the right.                     |
| 7     | Ticket Window     | Clear ticket surface, circular map and perforated date strip.               |
| 8     | Daylight Atlas    | From 2: pale map wallpaper, floating title and frosted information footer.  |
| 9     | Nightfall         | From 2: open map fading into ink, serif headline and date badge.            |
| 10    | Riso Flyer        | From 4: red ink on cream paper, oversized date and generous map.            |
| 11    | Blackout Bill     | From 4: condensed type, electric date band and contrasting venue/map strip. |
| 12    | Route Board       | From 6: panoramic map, connected when/where information and green signage.  |
| 13    | Platform Pass     | From 6: vertical date spine, blue destination panel and inset map.          |

All treatments render one combined information tile from the same real show
and venue data. The venue name opens its recorded website with the external
link icon. Date, time, support acts, admission and map information remain
available. Map points are approximate, and OpenStreetMap attribution remains
visible. Every variant uses the same on-demand tile URL and normal browser
caching; no tile images are bulk downloaded or archived as map data.

## Capture and decision

Desktop screenshots were captured for all thirteen treatments. The six new
treatments were also visually reviewed at a 390-pixel viewport, with no tile
overflow, loaded map images, and venue website links with external-link icons.
The original seven had already passed the same viewport checks.
TypeScript, lint, formatting and both the explicitly enabled prototype build
and default build pass. Prototype code and CSS are excluded from the default
build by the `VITE_VENUE_TILE_PROTOTYPE` gate.

The user prefers Transparent Atlas (2), Gig Poster (4) and Transit Strip (6).
The six additional studies extend those directions; no production winner has
been chosen. Any eventual selected design should
be implemented in the real components, with the remaining experiments retained
on this prototype branch. The branch pointer is captured in
`zivv-venue-tile-treatments`.
