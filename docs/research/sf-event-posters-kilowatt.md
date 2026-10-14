# Kilowatt dynamic calendar follow-up

The initial HTML-only investigation could not see Kilowatt's 33 listed shows.
On 2026-10-10 the parent inspected the [official calendar](https://kilowattbar.com/events),
which embeds DICE's public event-list widget. Its published script and client
configuration identify the public `/api/v2/events` feed and Kilowatt filter.
The feed returned 68 upcoming source records with no next page.

Twenty-five catalog shows initially matched one exact source record by San
Francisco venue, local date in America/Los_Angeles, and performer name. Each
source record carries its image and observed outbound show URL. All 25 images
returned successful HTTPS responses with recognized image signatures. They are
conservatively classified as event artwork. Cancelled/postponed source records,
missing dates, and unconfirmed spelling/description variants were excluded.

Raw evidence and checks: `.cache/kilowatt-dice-events.json`,
`.cache/kilowatt-artwork-checks.json`. Results: `.cache/sf-poster-results-4.json`.
These are additional matches, not a second copy of the initial batch-3 coverage.
The same deterministic sample audit applies before acceptance.
