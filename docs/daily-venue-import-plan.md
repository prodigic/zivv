# Daily venue imports and date-added discovery

Status: migration and discovery foundation implemented locally September 7,
2026; historical replay recognition and a deterministic three-venue shadow
pilot added September 8. See [pilot operations](venue-pilot.md) and
[migration and import operations](ingestion-migration.md) for current
behavior, commands, validation, and remaining work. The investigation and
original baseline below were prepared against checkout `71c3680`. No scheduled
crawler is enabled.

Follow-up: the [three-venue source investigation](venue-source-investigation.md)
tests Fillmore, Rickshaw Stop, and Bottom of the Hill. Verified URL metadata is
now saved in [`data/venue-sources.json`](../data/venue-sources.json); entries are
not enabled; the three pilot websites are joined into generated venue JSON. The investigation
adds concrete pagination, RSS revision, encoding, and coverage acceptance cases.

The [wider San Francisco investigation](sf-venue-investigation.md) adds three
Luna/high research groups, further URL records, room/identity conflicts, and an
explicit SF candidate backlog. All source entries remain disabled pending
adapter and coverage validation.

## Intended result

Run a daily batch against registered venue calendars, reconcile their listings
with Zivv, and publish validated additions and changes. Give every accepted show
a durable date added. Both Just Added and the weekly newsletter select that date
over a range, so importing a show on Tuesday does not prevent its inclusion in
Friday's weekly list.

Use ordinary fetching, parsing, hashing, and matching for routine work. AI is an
optional, budgeted extraction fallback. Keep the browser anonymous and served
from static JSON; the ingestion store and crawler run outside the browser.

## Baseline before implementation

| Evidence | Current behavior | Required change |
| --- | --- | --- |
| `src/lib/etl/processor.ts`, `scripts/merge-latest.js` | Text inputs produce `public/data`; latest-file merging compares normalized text. | Route weekly text and daily structured candidates through one reconciliation step. |
| `src/lib/etl/processor.ts`: `loadExistingCreatedAt`, `readLatestTxtIngestDate` | Creation dates are recovered from old generated chunks; unseen IDs receive the weekly file header date. | Persist event history independently of generated output and timestamp each input batch explicitly. |
| `src/lib/etl/utils.ts`: `generateEventId` | Identity hashes date, headliner, and venue; show time is absent. | Persist identity across corrections and distinguish multiple performances. |
| `src/pages/NewEventsPage.tsx`, `src/pages/NewsletterPage.tsx`, `src/components/ui/NewBadge.tsx` | Newness means creation day equals `manifest.latestIngestionDate`. | Use a shared added-date range query. |
| `src/types/events.ts` | Events and embedded artist/venue event summaries contain `createdAtEpochMs`; venue website is optional. | Define creation semantics and propagate them consistently to summaries and filters. |
| `public/data/venues.json`, `public/data/manifest.json` | Snapshot contains 624 venue records, zero populated websites; dataset generated August 22. | Register and verify sources; snapshot counts do not establish currently active venue counts. |
| `.github/workflows/etl.yml`, `.github/workflows/deploy.yml`, `package.json` | ETL has push/manual triggers, no daily schedule. `build` runs Vite; ETL compilation has its own command. Deployment has advisory quality steps. | Add an explicit scheduled ingestion-to-publication path with blocking data gates. |

The checkout does not contain the proposed `src/domain` or build-store modules
from earlier architecture work. Implement against the code here; a database
migration is not a prerequisite.

## 1. Establish the venue source registry once

Add `data/venue-sources.json`, validated by a versioned schema. Each entry needs:

- Stable source ID and canonical Zivv venue ID; venue aliases, city/address, and
  separate room IDs where relevant.
- Verified official calendar URL and approved ticket-provider venue ID/URLs.
- Adapter name/version, timezone, pagination method, published date horizon,
  required detail fields, and inclusion rules.
- Source state: active, unverified, temporarily failing, retired, or manual-only.
- Fetch cadence, per-host rate limit, last verification, and secondary source
  where available. Runtime fetch state lives separately from configuration.

Start with 10 representative venues, then expand by shared calendar platform.
Candidate names already in Zivv include Bottom of the Hill, Chapel, Rickshaw
Stop, DNA Lounge, and Gilman. Resolve aliases before crawling: this snapshot has
several Gilman variants, and similarly named venues in different cities must
remain distinct. Keep every identified venue accounted for, including those
awaiting onboarding; the dashboard denominator must not silently exclude them.

As a small feasibility check, the official [Bottom of the Hill calendar](https://www.bottomofthehill.com/calendar.html)
and [Chapel website](https://thechapelsf.com/) exposed listings through web
retrieval. This does not verify their full pagination or a production adapter.
Retrieval of DNA Lounge's calendar failed in this check; investigate during
onboarding rather than classify it as an empty calendar.

Default scope: music shows at registered Bay Area venues. Record exclusions for
non-music/private events and explicitly configured scope limits. Do not infer
genre eligibility from a headliner name alone; ambiguous listings remain visible
in review. Venue/source discovery is onboarding work, not a daily AI search.

## 2. Fetch and extract with a bounded token budget

Use this extraction order per source:

1. Documented or permitted structured API, JSON feed, RSS, or iCalendar feed.
2. Embedded JSON-LD event data. [Schema.org MusicEvent](https://schema.org/MusicEvent)
   defines useful fields including performance date, location, performers,
   ticket offers, and event status.
3. A deterministic HTML adapter shared by venues on the same platform.
4. Browser rendering when data cannot otherwise be accessed; parse the resulting
   event elements in code.
5. AI extraction only for unresolved changed event blocks. Poster OCR is a
   separately budgeted fallback where no usable text source exists.

For each registered listing page/feed, send conditional requests using saved
ETag/Last-Modified validators where supported. A successful unchanged response
can reuse the previous extraction for that exact resource. [HTTP conditional
requests](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Conditional_requests)
describe these validators and the 304 response.

Do not assume an unchanged first page means later pages or linked details are
unchanged. Discover and visit all required pagination within the source's
advertised upcoming horizon. Revalidate each required resource; refresh detail
pages on a defined cadence even if their listing card is unchanged. Prioritize
status checks for shows in the next 14 days; perform a weekly full detail sweep.
If a configured request/page limit is reached, mark coverage partial.

Hash the extracted event-relevant content after removing navigation, adverts,
rotating banners, and irrelevant timestamps. Cache parsed candidates by
`sourceId + resourceUrl + contentHash + adapterVersion + schemaVersion`.
Changing an adapter/schema forces reprocessing even when the source is unchanged.
Store fetch validators only with the body/extraction they validate; after cache
loss fetch a body again rather than treating an unusable 304 as empty data.

The AI request contains only bounded event blocks, source IDs, and the extraction
schema. It returns schema-validated candidates with source evidence; it does not
receive the entire database or decide canonical identity. Treat fetched text as
data, not executable instructions. Cache AI results with model/prompt version as
well. Never generate missing artists, dates, prices, or announcement times.

Proposed pilot ceilings, to tune from measurements:

| Budget | Initial setting |
| --- | --- |
| Routine parse/match/newness/coverage AI use | 0 tokens |
| AI input per fallback request | At most 4,000 tokens; split event blocks without losing records |
| AI output per fallback request | At most 2,000 tokens; truncation is a failed extraction |
| Daily fallback calls | At most 10, including retries |
| Daily AI total | At most 60,000 input plus output tokens |
| Automatic retry | One bounded retry, charged to the same budget |

Reserve the maximum request budget before dispatch, then reconcile actual
usage. Budget exhaustion queues unresolved candidates and degrades coverage;
it does not silently drop shows or block successful deterministic sources.

Illustrative arithmetic, not a measured forecast: scanning 100 pages at 8,000
input tokens each consumes 800,000 input tokens. If code resolves everything
except five 1,500-token blocks, AI input is 7,500 tokens, about 99% less.
HTTP requests, browser time, output tokens, and one-time adapter development
remain separate costs. Measure requests, bytes, changed blocks, tokens, runtime,
and accepted additions during the pilot before selecting a model or dollar budget.

## 3. Keep durable identity, history, and provenance

Use a small versioned, Git-tracked ingestion ledger initially, loaded into maps
at build time. Proposed files are `data/ingestion/events.json`,
`source-links.json`, and `runs.json`. Keep raw responses and large diagnostic
artifacts outside `public/` with bounded retention; they are not the only copy
of event history. A later server-side store can replace this persistence behind
an interface without changing browser JSON.

| Field | Meaning and rule |
| --- | --- |
| `eventId` | Permanent canonical ID; preserve existing IDs where possible and allocate collision-checked IDs for new events. |
| `firstImportedBy` | Immutable origin: `steveslist` or `zivv-venue-import`. Backfill every event in the pre-venue-import catalog as `steveslist`, based on the user's confirmation on September 7, 2026. |
| `createdAtEpochMs` | Public **date added**: first accepted insertion into Zivv; immutable during normal updates/reimports. Reuse the existing field rather than maintain a second competing timestamp. |
| `addedDateProvenance` | `observed`, `legacy-batch`, or `unknown`, to distinguish exact new insertions from migration estimates. |
| `firstObservedAtEpochMs` | Earliest captured candidate observation; retained even if review delays acceptance. |
| `updatedAtEpochMs` | Last material content change, not the latest crawl/build time. |
| `announcedAtEpochMs` | Optional source-supported announcement time, with evidence; never inferred from show date or date added. |
| `sources[]` | All contributing sources, with source kind (`steveslist` or `venue-calendar`), stable source ID, available provider event ID or canonical detail URL, original venue ID, first/last seen, content hash, run ID, and evidence pointer. Historical evidence fields may be unknown; do not invent URLs, issue dates, or run IDs. |
| `firstImportRunId` | Durable batch provenance for diagnosis and replay. |

Set date added when a candidate becomes an accepted canonical event; freeze that
timestamp in the candidate commit so publication retries cannot reset it. Failed
fetches or unresolved review candidates are not accepted additions. Run records
track accepted, committed, and published stages separately.

Match in this order: existing source-ID mapping; known canonical ticket/detail
URL; then a conservative candidate match using canonical venue/room, local date,
performance time, and normalized lineup. Ambiguous matches go to review.
Date + venue alone is insufficient for early/late shows. A reschedule linked by
provider ID updates the same event; a second performance is a new event. Preserve
manual corrections and define field-level precedence: explicit manual override,
then authoritative source for that field, then fallback source. Record conflicts.

When the same venue has multiple listings on one date, reconciliation also
compares the performer sets. A close lineup with the same parsed time is merged;
a close lineup with distinct precise times is retained as a second event and
tagged `multiple-show`; a close lineup involving a legacy or uncertain time is
held for review. This prevents a rewritten bill from creating duplicates while
keeping a plausible early/late performance visible for manual confirmation.

Both weekly text and venue import candidates use this same reconciliation logic.
The current text-only merge cannot safely establish cross-source identity. Do not
round-trip structured events through lossy text just to invoke that merge script.
Parse legacy text with the existing parser, normalize daily data to the same
candidate contract, reconcile, and export through existing indexing/chunking.

The user confirmed that **all prior events were sourced from Steve's List**.
Bootstrap the pre-venue-import catalog with `firstImportedBy: steveslist` and a
Steve's List source association. Record this user-confirmed migration basis;
there is no `legacy-unknown` origin for that catalog. Source certainty is separate
from date-added precision: the original newsletter issue, ingestion run, or
first-seen timestamp may still be unknown.

For new events, set `firstImportedBy` from the accepting import and preserve it
thereafter. If a venue crawler finds an existing Steve's List show, add its
venue-calendar source association without changing origin or date added. If
Steve's List later includes a Zivv-discovered show, add the Steve's List source
association while retaining `firstImportedBy: zivv-venue-import`. Support both
"first imported by" and "listed by" filters; a show can be listed by both sources
while having only one original importer. This remains planned schema/migration
work; the current generated event records do not yet contain these fields.

Bootstrap once from the committed generated chunks. Preserve existing creation
dates as `legacy-batch`; where history is absent, use nullable/unknown added-date
metadata and exclude those rows from latest filters until resolved. Version the
contract and update affected consumers for nullability. Never timestamp the
entire old catalog as newly added. On cold rebuilds, a missing ledger is an error,
not permission to recreate first-added dates. Maintain identity redirects if a
reviewed duplicate merge retires an existing ID; retain the earliest known date.

## 4. Define daily and weekly newness explicitly

All stored instants are UTC. Date-picker boundaries and week boundaries are
computed in `America/Los_Angeles`, including daylight-saving transitions.

```text
addedInWindow(event, start, end) =
    event.createdAtEpochMs is known
    AND start <= event.createdAtEpochMs < end
```

Proposed product defaults:

- **Just Added:** additions within the last seven local calendar dates including
  today, newest added first. Offer Today, Last 7 Days, and custom added-date range.
  Show a visible `Added Sep 8` label on cards/details.
- **Weekly additions:** query the complete canonical store between the previous
  successful weekly cutoff and this run's frozen cutoff. Do not select only rows
  inserted by the weekly merge. First run uses the preceding seven local days.
- **Announced this week:** use a verified announcement date if that label is
  required. Otherwise label the section **Added this week**; finding an old
  announcement today does not establish that it was announced today.
- **Changed shows:** price, lineup, cancellation, and reschedule updates can have
  a separate updates list; they never reset date added.

Example: a show scheduled for December enters Zivv Tuesday, September 8. It appears
in Just Added immediately. Friday's September 11 weekly source also contains it;
reconciliation attaches that source to the existing row. Its September 8 date
still qualifies it for the weekly additions window. Saturday's price update does
not make it newly added again.

Persist each weekly edition's ID, window, dataset version, and selected event IDs.
Advance its cutoff only after the edition artifact is successfully published;
retry a failed edition with the same window and membership. A missed week uses
the last successful cutoff, preventing a gap. Corrections to an already published
edition require an explicit revision. No newsletter sending is implied here.

After ingestion, run `npm run local-acts:check`. The command selects every
performance dated within seven calendar days starting on the edition date,
including shows imported in earlier editions. Override the window with
`--start YYYY-MM-DD --end-exclusive YYYY-MM-DD`; use `--recheck` to audit all
performers again. It reports performers without evidenced decisions in
`data/local-artist-verification.json`. Legacy list membership and unresolved
searches remain eligible for review. Review each candidate on the web, preferring the act's
official site or profile and then a venue bill or reputable local press. Mark an
act local only when the evidence identifies the Bay Area or Greater Bay Area
(including a named city such as San Francisco, Oakland, Berkeley, or San Jose).
Record the decision and source URL with `--method web-search`, for example
`--record "Act=local" --location "Oakland, California" --source "https://example.org/bio" --evidence "Official biography identifies an Oakland band."`; use
`--record "Act=non-local"` when the source identifies another home region. The
decision is durable and updates the compatibility local-artist lists used by the
browser. Store inconclusive research as `unresolved`, never as a guessed visitor.
ETL derives browser lists from evidenced decisions and includes role-marked
aliases. The newsletter, directory, and navigation never infer locality from
show counts or the number of venues played.

Build weekly additions before applying presentation filters. Keep the full
membership, including shows that happened before the digest ran; group those as
already happened or omit them only from the upcoming presentation. Keep the
existing selected-city scope. For upcoming shows, compare actual start times or
the local show date when time is unknown, so tonight's shows survive midnight.

Implement the range predicate once and reuse it in NewEventsPage, NewsletterPage,
NewBadge, event filters, and embedded artist/venue summaries. Keep
`latestIngestionDate` for legacy batch context only. Export a small
`recent-additions.json` index with event IDs, added dates, and month references,
so discovering a newly added December show does not require loading every month.
Version the manifest/cache and verify warm-browser refresh after publication.

## 5. Validate coverage, not just parser success

For every venue/source run, record discovered listing IDs, pagination completion,
observed horizon, last successful fetch, required-detail completion, and counts:

```text
discovered = matched + inserted + excluded-with-reason + unresolved
```

Count distinct source occurrences before canonical deduplication; separately
report unique canonical shows. Compare discovered records with the prior source
snapshot and with a ticket-provider/secondary inventory when available. Use
source-advertised totals and independent listing links to catch extraction loss:
a parser's own output cannot prove it parsed everything.

Coverage states are `complete-for-source`, `partial`, `failed`, and `unverified`.
Complete requires exhausted pagination, accounted-for records, no unresolved
in-scope candidates, and completed required detail extraction. A reused snapshot
must carry its observation time and be valid for every required resource.

Flag sudden zero results, large count drops (initial warning threshold: 30% against
the comparable future horizon), missing next-page processing, stale sources,
secondary-only listings, conflicts, and budget-deferred extraction. Report both
known venues not yet onboarded and failures among enabled sources. Successful
request status alone is never a green coverage result.

Missing from a calendar does not mean cancelled: retain the event and investigate.
Apply cancellation only from explicit authoritative evidence or manual correction.
Use failed sources' last good data while allowing independently validated sources
to publish; attach a degraded coverage report. Structural ledger/export failures
block the whole release.

No crawler can prove that an unannounced, private, or inaccessible show does not
exist. The measurable promise is complete reconciliation of each verified public
source's stated horizon, with blind spots shown explicitly. Weekly full sweeps
and sample manual comparisons test whether the source/adapter coverage is adequate.

## 6. Run and publish reliably

Propose a repository-owned daily GitHub Actions job at 06:17 Los Angeles time,
plus manual replay/dry-run inputs. This is a target cadence, not a deadline
guarantee: [GitHub schedules](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)
run on the default branch and can be delayed or dropped. Track overdue runs
(initial threshold: 30 hours) and make the weekly job check ingestion freshness.

Daily and weekly ingestion share one non-cancelling writer lock. Their sequence:

1. Read the committed ledger, immutable run ID/time, configuration, and prior
   source snapshots. Fetch with timeouts, per-host limits, Retry-After handling,
   bounded backoff, and permitted-source access rules.
2. Extract, validate, reconcile, and generate a per-venue coverage/delta report.
3. Stage the ledger and static outputs in a temporary directory. Run integrity
   checks there; the existing processor deletes chunks early and must not write
   directly over the last good production dataset during validation.
4. Run ETL compilation explicitly (`npm run build:etl`), focused ingestion and
   export tests, applicable lint/type checks, and the Vite build. Check duplicate
   identity, immutable dates, references, valid timestamps, and exact served-file
   byte sizes/checksums. Make ingestion gates blocking.
5. Commit accepted ledger/source state and generated data together. Keep bulky
   fetch bodies and detailed diagnostics in retained artifacts. If the target
   branch advanced, reload its ledger and repeat reconciliation before committing;
   never resolve conflicting canonical state with a blind JSON merge or force-push.
6. Invoke the validated build/deploy path explicitly in the same workflow or a
   reusable workflow. A push made with `GITHUB_TOKEN` does not trigger another
   push workflow, per [GitHub's workflow trigger documentation](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow).
   Retain repository branch protections and required checks.
7. Verify the published manifest and a known added event, then mark the run
   published. A failed deployment retries the same commit; first-added timestamps
   stay fixed. Regenerate and redeploy from a prior complete commit to roll back.

Integrate with the existing ETL/release triggers so an automated data commit
cannot start a competing writer or a release loop. Reconcile the configured
Node runtime with the locked toolchain before enabling the job; existing ETL
and deploy workflows specify different Node majors.

No content changes means no event timestamp churn and no unnecessary site build;
still persist successful checks/coverage. Notify only about failed/overdue runs,
significant coverage degradation, or unresolved review work. Operational run
metrics stay outside browser analytics. Once enabled, the weekly job performs a
freshness check/full sweep, imports weekly text, then freezes its digest window.

## 7. Delivery sequence and acceptance gates

VI-1 and VI-2 now have local implementations. VI-4 has shared reconciliation
and review reports; source completeness/coverage reporting is still pending.
VI-3 has researched registry entries, with adapters still pending. VI-5 through
VI-7 remain planned. See the migration handoff for verification and limitations.

| Ticket | Scope | Depends on | Acceptance gate |
| --- | --- | --- | --- |
| VI-1 | Durable identity/date-added ledger and migration | None | Cold rebuild/replay preserves IDs and dates; legacy catalog does not flood latest lists. |
| VI-2 | Shared date-range query, labels, additions index, weekly editions | VI-1 | Tuesday daily insertion remains in Friday's weekly list; December show is discoverable without all-month loading. |
| VI-3 | Source registry and 10-venue adapter pilot | None | Verified venue/room mappings, source URLs, pagination and fixture inventories for each pilot source. |
| VI-4 | Shared weekly/daily reconciliation and coverage reporting | VI-1, VI-3 | Same show across sources becomes one row; early/late performances remain separate; partial fetches cannot appear complete. |
| VI-5 | Bounded AI fallback and extraction cache | VI-3, VI-4 | Unchanged input uses zero AI tokens; retries and truncation obey budget; evidence-less output is rejected. |
| VI-6 | Scheduled writer, blocking validation and explicit publication | VI-2, VI-4 | Dry-run, conflict recovery, failed deployment replay, and warm-cache visibility verified. |
| VI-7 | Expand venue coverage and operational handoff | VI-6 | Seven consecutive daily runs and one weekly cycle meet pilot gates; remaining venues have explicit onboarding states. |

AI fallback is optional for VI-6: deterministic sources can launch first while
unsupported sources remain visible as gaps. The first useful milestone is VI-1
plus VI-2, which fixes weekly newness before introducing a crawler.

Required fixtures cover unchanged responses, lost cache, changed parser version,
pagination failure, zero-result regression, two sources for one show, two shows
at one venue/date, reschedules, manual overrides, unknown historical added date,
midnight/DST boundaries, late candidate approval, missed weekly runs, atomic
failure recovery, and missing generated output with an intact ledger. Use saved
source fixtures for deterministic tests; separate bounded live smoke checks.

Pilot exit target: every discoverable in-scope fixture show accounted for; zero
unresolved identity conflicts in auto-published additions; zero false new events
on replay; weekly membership test passes; daily AI cap enforced. Record measured
token/HTTP/runtime costs and source limitations before expanding.

Tracking note: `bd` is unavailable in this environment, so these tickets are
recorded here for handoff; no Beads issues were created or updated. Existing
`.beads/issues.jsonl` entry `zivv-3xi` concerns release-trigger integration and
should be reviewed when implementing VI-6. Implementation should validate its
current status rather than assume the checked-in snapshot is current.
