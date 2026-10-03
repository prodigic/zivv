# Seven single-tile treatments

Question: what could the combined show and venue-map tile look like, including
transparent surfaces and wallpaper? The user requested seven experiments.

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

[Open the studies](http://127.0.0.1:5176/zivv/events/2026-10-06-the-menzingers-great-american-music-hall?variant=3).
The floating bar selects 1–7; its arrows and keyboard left/right arrows cycle
through the treatments. The selected `?variant=` remains shareable and stable
on reload. Input fields keep their normal keyboard behavior.

| Study | Treatment         | Idea                                                                  |
| ----- | ----------------- | --------------------------------------------------------------------- |
| 1     | Clean Split       | Restrained shared surface, compact type, map on the right.            |
| 2     | Transparent Atlas | The real map becomes wallpaper behind floating text.                  |
| 3     | Night Glass       | Transparent glass on luminous abstract wallpaper, with an arched map. |
| 4     | Gig Poster        | Acid-yellow poster, emphatic condensed type, angled map sticker.      |
| 5     | Editorial         | Warm paper, serif title, oversized day and generous map.              |
| 6     | Transit Strip     | Map as a full-height left rail, itinerary on the right.               |
| 7     | Ticket Window     | Clear ticket surface, circular map and perforated date strip.         |

All treatments render one combined information tile from the same real show
and venue data. The venue name opens its recorded website with the external
link icon. Date, time, support acts, admission and map information remain
available. Map points are approximate, and OpenStreetMap attribution remains
visible. Every variant uses the same on-demand tile URL and normal browser
caching; no tile images are bulk downloaded or archived as map data.

## Capture and decision

Desktop screenshots were captured for all seven treatments, and all seven were
checked at a 390-pixel viewport for horizontal overflow and loaded map images.
TypeScript, lint, formatting and both the explicitly enabled prototype build
and default build pass. Prototype code and CSS are excluded from the default
build by the `VITE_VENUE_TILE_PROTOTYPE` gate.

The experiment establishes seven working options, not a selected winner.
Transparent Atlas puts geography first; Night Glass emphasizes translucency;
Clean Split preserves a quieter hierarchy. Any eventual selected design should
be implemented in the real components, with the remaining experiments retained
on this prototype branch. The branch pointer is captured in
`zivv-venue-tile-treatments`.
