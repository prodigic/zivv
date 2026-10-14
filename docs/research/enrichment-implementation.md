# Show artwork and local-act vibe checks

Reviewed metadata is stored in `data/event-posters.json` and
`data/artist-reviews.json`. ETL validates each entire registry before applying it
to the public export. These overlays do not rewrite the shared ledger, canonical
IDs, stable slugs, first-added dates or source observations.

Poster identity binds the event ID, stable slug, current date, venue ID/name and
headliner ID/name. A later reschedule, room move or rename skips the old artwork
and emits a data-quality warning. Stable slugs can contain an earlier show date;
validation compares the reviewed current date with the event, not its URL text.
Artist reviews require the exact artist ID/name, safe HTTPS source links, known
review kind and publication dates no later than their research date.

Venue directory, venue detail and the event page's venue list show lazy-loaded
36-by-44-pixel artwork links. Clicking an image opens the observed official show
or ticket page separately from the internal show link. Failed images keep their
frame and a usable Show link. An image is called a poster only when the source
establishes that; promotional imagery is labelled event artwork.

Local-artist cards and artist detail pages show concise original summaries with
publication links, reviewed work and dates. Release-based descriptions concern
recordings; live descriptions identify a past performance. Missing reviews do
not produce guessed genre descriptions. Billing aliases reuse verified identity
research; solo/acoustic/duo variants do not inherit different-configuration live
reviews.

Research coverage, negative outcomes and alias relationships are retained in
`local-act-review-catalog.json`; show coverage is in
`sf-event-poster-coverage.json`. Not-found means a bounded search did not establish
a usable source, not that none exists. The model trial and independent samples
are documented alongside these files. No per-agent token or billing telemetry
was available, so the model selection is based on observed quality and rework.

Future updates should research only new or changed identities, retain direct
source evidence, run both metadata validators, rebuild ETL and review stale-ID
warnings. Run the ingestion/component suite and frontend typecheck before
publishing. Refresh and verify the shared encrypted ledger snapshot together
with each public export, even though these overlays leave the ledger unchanged.
