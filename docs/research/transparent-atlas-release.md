# Transparent Atlas production selection

The user selected study 2 on October 9, 2026 and authorized rebasing and
publishing the site. `EventAtlasCard` implements that selection as a single
map-wallpaper tile above the artist cards. The venue name opens its website
with an external-link icon, or its directory page when no website is known.
Supporting-artist navigation, ticket links, admission, first-added labels and
show notes remain available. Missing or failed maps keep the show details and
an appropriate map/search link. Attribution stays readable above the wallpaper.

The thirteen experiments remain on `codex/prototype-venue-treatments` at
`b979506`. The production branch starts from the venue implementation and was
rebased onto main `694ba65`; it does not include the experiment switcher.

## Data reconciliation

Generated-data conflicts were resolved by regenerating from the current shared
ledger, never by restoring the earlier snapshot. The encrypted baseline and
backup both verify revision
`5d2360394cf1242b9cc98e2124a850885cf4df0e49e75eb9249783812e38d0c4`.
The regression guard reports zero record changes: 4,641 events, 8,678 artists,
656 venues, six import runs and 283 redirects.

All 18 event chunks match current main byte for byte. All 22 manifest file
entries pass checksum/size checks, and event entity references resolve.
The export reapplies the reviewed address/map registries: Stanford Stadium's
university-sourced Stanford city and the researched Fillmore/Bottom of the Hill
website destinations take precedence over the older export overrides. Upcoming
lists naturally omit a show that started between exports. The October 9 edition,
event IDs, dates added and ingestion history are preserved.

The 594 reviewed map locations remain unchanged. Five venues added after the
original research use the unmapped fallback: Lanesplitter Pizza, Mothbelly
Gallery, Goorin Headquarters, Shed A and Wardlaw Skatepark. Follow-up evidence
work is tracked in `zivv-new-venue-map-evidence`; the previous unresolved
locations remain tracked in `zivv-unlocated-venue-maps`.

## Verification

- 273 ingestion/component tests pass, including map failures, unknown locations,
  external venue links, supporting artists, tickets and cancelled status.
- 151 Storybook browser tests pass.
- TypeScript, repository lint, source formatting and production build pass.
- Desktop and 390px mobile reviewed with a loaded map, readable attribution,
  venue website/icon and no tile overflow.

Publication is complete only after the main deployment and live verification.
