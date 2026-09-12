# Bottom of the Hill adapter

`src/lib/ingestion/venues/bottom.ts` implements the deterministic pilot for
[Bottom of the Hill](https://www.bottomofthehill.com/). It fetches the official
calendar and `RSS.xml` through `VenueFetchContext.fetchText`, so transport,
conditional requests, cache reuse, and source charset decoding stay outside the
adapter.

The calendar is the primary coverage surface. Event rows are selected by their
detail URL and parsed with the shared DOM helper. The parser preserves the
calendar's local date, doors and show instants, ordered band names, age state,
verified venue-hosted ticket URL, sold-out image state, and a session label for
time-range performances. Prices map the face or advance value to
`priceMin`, the door value to `priceMax`, and retain fee-inclusive text in
`notes`; this keeps the three price concepts visible without inventing a new
shared contract field. Spinner-only band rows are retained in source notes and
are not promoted as performer names.

RSS is treated as update history. Items are normalized to canonical HTTPS event
URLs and deduplicated by URL, with the latest valid `pubDate` revision retained.
When a calendar listing has an unannounced band, a matching RSS revision can
fill that slot; the calendar remains authoritative for current fields. A
calendar listing missing from the current RSS horizon stays in `listings` and
adds an explicit `RSS feed gap` warning. The second inventory exposes the
deduplicated RSS keys for reconciliation.

The reported coverage start is the current local date used by the fetch context,
even when the first observed show occurs later. The coverage end is the last
dated calendar listing in the observed source window.

The adapter reports `complete: true` only when both responses contain a
structurally complete, non-empty source and every discovered calendar row is
valid. Feed gaps are coverage facts and do not make the calendar baseline
incomplete. Empty, malformed, truncated, or failed responses make the result
incomplete while retaining any valid calendar rows already parsed.

The September 7, 2026 investigation snapshot contained 67 calendar rows from
September 7 through December 12 and 990 RSS items representing 545 distinct
event URLs. There were 66 future-dated RSS URLs, with revisions for October 6
and no RSS URL for the calendar's October 8 Casa Sueño show. A live official
calendar refresh on September 8, 2026 confirmed the same field conventions and
the venue's statement that the first listed act is the headliner. These counts
describe the observed source horizon; they are not an exhaustive claim about
all shows or future changes.

The pilot does not follow every detail page. It relies on the complete current
calendar for fields that are visible there and retains RSS-only historical or
package revisions as feed inventory evidence. Ambiguous programming is kept as
`non-music`, `package`, or `review` with a reason so a later coverage pass can
make a deliberate decision.
