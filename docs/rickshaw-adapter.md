# Rickshaw Stop adapter

`src/lib/ingestion/venues/rickshaw.ts` is a deterministic adapter for the
official [Rickshaw Stop calendar](https://rickshawstop.com/calendar/). It uses
the shared `htmlDocument` helper and `VenueFetchContext.fetchText`; transport,
conditional caching, decoding, request budgets, and cache persistence remain
outside the adapter. The adapter version is `rickshaw-stop-v1` and the normal
path makes no model calls.

## Official source surfaces

The calendar response contains two presentations of the same upstream event
inventory:

- `.seetickets-calendar-event-container` blocks are the primary discovery
  surface. Their enclosing `.seetickets-calendar-year-month-container` and
  date cell provide the year, month, and day. The parser scans the complete
  document sequence and records every valid month heading, including empty
  grids between populated months.
- `.seetickets-list-event-container` cards enrich a calendar occurrence with
  headliners, supporting talent, age, prices, genre, and presentation. The
  `.headliners`, `.supporting-talent`, `.see-showtime`, `.see-doortime`,
  `.ages`, and `.price` selectors are captured in saved fixtures.

The September 7 investigation found 61 calendar occurrences across 12 month
grids from September 2026 through August 2027. The September 8 official
refresh used for this adapter still exposed the 12 month grid structure and
the numbered list controls for pages 1 through 7. Empty January and March
grids are retained as source evidence; an empty month never ends discovery.
The calendar inventory is complete only after at least 12 valid month headings
are present and each discovered event has a valid date.

## List pagination

The visible numbered controls are `<li data-see-ajax-page="N">` elements. They
do not currently carry ordinary `href` attributes. The publicly linked
[`seetickets-custom-scripts.min.js`](https://rickshawstop.com/wp-content/plugins/V35.3.1b/js/seetickets-custom-scripts.min.js)
shows the normal browser request made when a user clicks one of those
controls. It is a read-only `GET` to the same origin's
`/wp-admin/admin-ajax.php` with this exact query shape:

```text
action=get_seetickets_events
nonce=<seetickets_ajax_obj.nonce>
listType=<pagination data-list-type, currently grid on the official page>
seeAjaxPage=<N>
currentList=<pagination data-nth-list-element, normally 1>
```

The adapter accepts that request only when the source page itself exposes
`seetickets_ajax_obj`, its `ajax_url` resolves to the calendar origin over
HTTPS at `/wp-admin/admin-ajax.php`, and a non-empty public nonce is present.
It follows same-site `/calendar` links when the page supplies real public
links. It does not derive an endpoint or nonce from a page number, use a
private framework payload, or open ticket detail pages. The bounded page limit
is 20; all advertised pages through that bound are attempted. A September 8
read-only check of the source-provided request for page 2 returned HTTP 200
and 10 list-card fragments.

If the source exposes data-only controls without the public settings, or a
page request fails or returns no cards, `list-pages` remains explicitly
partial. Calendar listings already discovered stay in the result, and any
unmatched list card is retained as a `review` record with an unresolved date
reason. The adapter never turns a missing page into a complete inventory.

## Identity, URLs, and status

The source key is
`<sourceId>:<ticketIdentity>:<YYYY-MM-DD>:<HH:MM|unspecified>`. Calendar and
list records merge on verified provider identity, date, and show session;
duplicate presentations collapse while two sessions on the same ticket ID
remain separate. A list card with a short date receives a year only when its
provider ID, month/day, and session resolve to one calendar occurrence.

Only the configured See Tickets, Eventim, and Ticketmaster hosts, plus the
source-linked `www.axs.com` host used by the official JT listing, are trusted;
provider event IDs must be in the expected event path. The observed
See Tickets/Eventim redirect for numeric ID `696618` is the sole verified alias;
provider IDs are not equated globally. URL Defense v3 wrappers are decoded only
to validate the embedded destination, the original wrapped URL remains in
`ticketUrl`, and untrusted destinations are retained as `review` evidence.
Social sharing links are ignored.

The source's `button-soldout` class is an availability signal even when the
visible action says `More Info`; the result keeps both the `sold-out` status
and an explanatory note. A plain `More Info` action without the sold-out class
does not become sold out. Status, ticket availability, and event identity stay
separate.

## Event scope and completeness

Live listings use explicit list headliners and supporting talent. Nerd Nite,
lectures, panels, comedy, and spoken-word programming are retained as
`non-music` with no invented artists. Explicit dance, DJ, rave, and themed-night
cues without a verified roster are retained as `review` with an empty artist
list. A release-party phrase does not override a band's explicit headliner;
presenter text and famous names in a theme title do not become artist records.

The first result inventory is the calendar baseline, with keys in the same
namespace as returned listings. The second inventory is resolved list-page
coverage. `complete` requires a complete 12-month calendar, every advertised
list page fetched through the bound, and every fetched card reconciled to a
calendar occurrence. Partial enrichment preserves all calendar shows and
reports the exact page or card gap in `warnings` and the inventory reason.

## Validation

Sanitized fixtures under
`src/test/fixtures/venues/rickshaw/` cover empty months, duplicate
presentations, wrapped and unknown URLs, sold-out status, ambiguous dance and
non-music titles, multiple sessions, page gaps, and truncated responses. Run:

```text
node node_modules/vitest/vitest.mjs run --config vitest.ingestion.config.ts --configLoader runner src/test/ingestion/rickshaw-adapter.test.ts
```

The adapter's TypeScript file also passes the focused strict compile used for
the ingestion workstream. Full repository compilation may report unrelated
changes in other venue adapters while those workstreams are in progress.
