# Historical Steve's List enrichment plan

Tracking issue: [#66](https://github.com/prodigic/zivv/issues/66).

Proposed October 16, 2026. This document plans assessment and implementation;
it does not authorize a production backfill, publication, or Friday automation activation.

## Outcome and observed baseline

Use the archive to extend past-show history, improve artist/venue identity and
source evidence, and strengthen importer regression coverage. Keep the current
manual Friday release working at every checkpoint.

The initial directory inspection found 83 text files totaling 11,793,209 bytes in
`D:\archive\steveslist`, named March 14, 2025 through October 10, 2026.
The current checked-in manifest contains 4,726 events, 8,843 artists and 661 venues,
with event dates January 4, 2026 through October 10, 2027. These are baseline
observations, not archive completeness or unique-event counts.

The October 10 archive filename contains a header dated October 9. Filesystem
timestamps reflect copying and cannot establish delivery or publication time.
Phase 1 must establish dates from content and retain discrepancies explicitly.

## Scope and priority

1. Inventory, isolated replay and coverage/conflict report.
2. Importer regression fixtures and safe historical observation support.
3. Reviewed historical backfill and past-show pages.
4. Source change history and explainable artist connections.
5. Optional aggregate trends, after coverage and price semantics are understood.

Photos, reviews, social links and current venue website/address verification remain
separate enrichment work. Historical evidence can supply candidates for that work.
No database replacement is required: retain authoritative SQLite and static JSON
as the browser delivery boundary.

## Data rules

- Preserve every original byte in private storage outside Git/public artifacts;
  index each file by SHA-256, size, filename and detected encoding. Never rewrite
  the archive in place. Retain exact-source links in private reports.
- Record header edition date, filename date, optional verified delivery timestamp,
  archive ingestion timestamp and parser/rules version separately. Unresolved
  dates or year inference block the affected records from application.
- Treat each listing as an observation of a scheduled show, not proof it occurred.
  Absence in a later edition is not cancellation. Explicit cancellation and sold-out
  observations carry source dates and do not silently reverse newer evidence.
- Keep existing IDs, slugs, redirects, original first-added dates and frozen weekly
  membership. Add a separate earliest-archived-mention field; it means earliest
  evidence within this corpus, not the actual first announcement.
- Backfilled records never qualify for current new-show badges or weekly additions
  merely because they were imported today. Define and test this for newly created
  historical entities as well as already known ones before any live application.
- Older observations cannot overwrite newer canonical prices, lineups, status,
  address or identity decisions. Same-date conflicts need explicit resolution.
  Missing values are not instructions to erase metadata.
- Match exact existing source identities and reviewed aliases first. Artist/date/
  venue evidence generates candidates; it cannot automatically collapse multiple
  performances, matinees, festivals, reschedules or tribute acts. Keep ambiguous
  matches in a review queue with reasons and source references.
- Repeated local appearances do not establish artist locality. Historical venue
  addresses remain dated evidence until verified for current use.
- Preserve advertised price text, ranges, fees and advance/door distinctions.
  Do not infer attendance, sales, popularity or comparable ticket prices from
  sold-out observations or incomplete listings.

## Implementation checkpoints

| Phase                   | Deliverable                                                                                                                                      | Acceptance / safe stop point                                                                                                                                              |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Inventory            | Read-only inventory and date/encoding/gap report; hash manifest; exact duplicate detection                                                       | Every file accounted for, discrepancies visible, no live store access or archive mutation                                                                                 |
| 2. Isolated replay      | Parse all editions chronologically into a disposable private store; compare against a consistent read-only baseline snapshot                     | Every candidate row classified as parsed, explicitly excluded, or unresolved; unique entities and matches reported; live ledger and Friday state unchanged                |
| 3. Reliability          | Small representative regression corpus, parser fixes where justified, full-archive replay harness                                                | Explicit tests cover wrapped lines, cancellation, year rollover, multiple performances, aliases and replay; current Friday fixture still passes                           |
| 4. Historical contracts | Historical import mode, dated observations, separate earliest-archived mention, field precedence, review receipts and resumable batches          | Dry-run produces exact mutation proposal; hashes bind source, rules and baseline revision; repeat/interrupt/resume tests prove no duplicates or weekly-membership changes |
| 5. Pilot                | Review a stratified sample across months/formats plus all proposed current/future event mutations; apply a small batch only in an isolated store | All critical identity/date/status errors resolved; changes and unresolved cases reported; no existing IDs/dates lost; public export and recovery rehearsal pass           |
| 6. Backfill             | Operator-approved, bounded batches into shared ledger; checkpoint receipts and encrypted backups                                                 | Revalidate against current ledger before each batch; retry is safe; failed batch rolls back; Friday writer can run between batches; no cutoff advancement                 |
| 7. Publish history      | Historical chunks and paginated artist/venue past-show views, with scheduling/cancellation labels and coverage explanation                       | Current/future loading stays correct; desktop/mobile, cached/fresh and payload tests pass; validate artifact and live release before claiming publication                 |
| 8. Derived features     | Dated change timeline, shared-bill links, optional price/activity summaries                                                                      | Every claim traces to observations; canceled shows excluded or labeled; coverage denominators and limitations visible                                                     |

Each phase should be a small reviewable PR or bounded set of PRs. Phase 3 can start
after Phase 2 produces representative failures; Phase 4 need not wait for optional
parser coverage improvements that do not affect its accepted inputs. Phase 8 is
optional and does not block useful history publication.

## Assessment outputs and decision gate

The first milestone produces a private machine-readable inventory, row-accounting
report, match/conflict queue and human-readable aggregate summary. Report:

- Verified edition span, gaps, duplicate files, filename/header disagreements and
  invalid encodings; do not call a weekly gap missing data without checking coverage.
- Total observations versus distinct proposed events, artists and venues.
- Exact matches, reviewed-alias matches, ambiguous matches and proposed new entities.
- Existing records with additional fields, conflicting fields or older status evidence.
- Event-date coverage gained, including past records versus still-future listings.
- Parse failures and explicit exclusions, with no silent dropped rows.
- Estimated storage/export growth, run time and remaining human-review workload.

After this report, select the first backfill scope and approve the identity/temporal
rules before implementing live application. Counts and cost estimates must come
from the assessment, not multiplication of repeated weekly listings.

## Friday isolation, recovery and publication

Follow [shared-ledger.md](shared-ledger.md) and the existing
[Friday delivery plan](friday-delivery-plan.md). Do not send historical editions
through the ordinary weekly load command or reuse its current-import semantics.

Use disposable stores for replay. Obtain a consistent baseline through supported
snapshot/export mechanisms; do not copy an open SQLite file without its WAL or
restore an old snapshot over the authoritative store. Keep raw text, review queues,
clear ledgers, keys and full replay logs private.

Before live application, verify ledger status and recovery; bind the reviewed batch
to the current revision and re-review on drift. Use short transactional batches
and the existing writer/ownership protections. A paused job retains an explicit
cursor and receipts, and must not monopolize the Friday writer. Test a Friday
import between backfill batches and resume without duplication.

Every checkpoint preserves the documented manual Friday commands. A failed
historical job must leave Friday importing usable. Test unchanged first-added
dates, edition membership, cutoff, source provenance and newer canonical fields
against a representative baseline, including interruption and repeated execution.

Publish only validated public output with the matching encrypted recovery snapshot.
Use existing candidate/live verification and retain the prior verified artifact.
Public rollback restores the artifact, not the private ledger; a bad committed
backfill requires a reviewed compensating repair preserving provenance and any
Friday writes that happened afterward. Rehearse that repair before the live pilot.
No scheduler or controlled-publisher activation is part of this work.

## Agent allocation and token budget

Use deterministic enumeration, hashing, parsing, matching, diffs and summaries for
the entire corpus. AI is reserved for bounded ambiguous cases and code review.

| Work package         | Small delegable tasks                                            | Responsibility / quality gate                                                       |
| -------------------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Inventory            | Date-gap tables, duplicate groups, header-date discrepancy lists | Lower-cost Luna/Terra candidate; mechanically verify against file manifest          |
| Replay               | Failure categorization and source-referenced examples            | Lower-cost candidate; deterministic row accounting is authoritative                 |
| Regression corpus    | Extract minimal fixtures and expected edge-case tables           | Lower-cost candidate; Sol reviews expected semantics and provenance                 |
| Historical contracts | Documentation tables and fixture scaffolding                     | Sol high owns identity, precedence, transaction and weekly-isolation decisions      |
| Pilot/backfill       | Prepare bounded ambiguity packets and summarize mutation diffs   | Lower-cost candidate proposes; Sol high audits; ambiguous identities stay unapplied |
| UI/history           | Copy, fixture lists and isolated presentation tasks              | Lower-cost candidate; integration owner verifies loading and performance            |
| Derived features     | Counts/coverage tables from approved observations                | Deterministic calculations; Sol checks interpretation and traceability              |

Before bulk delegation, trial two small comparable ambiguity batches on available
lower-cost models and Sol high. Do not assume model availability or substitute a
requested model without agreement. Record model/reasoning, batch size, elapsed time,
reported token usage, accepted results, substantive errors and rework. Use actual
cost only if available; do not fabricate price or token measurements.

Audit each pilot batch and then a stratified 10% sample of each research batch
(minimum 10 records, or all if smaller) with Sol high. Review every low-confidence,
identity-changing or status-changing proposal regardless of sampling. Any critical
wrong-artist, wrong-venue or wrong-date finding blocks that batch and triggers
full review of the affected category. Audit outputs retain evidence and corrections.
Report model/results as work proceeds; do not use Astra by default.

## Completion evidence

The first useful deliverable is the assessment report, not a production import.
Historical enrichment is complete only for the explicitly accepted scope when
all applied rows are traceable, unresolved work is counted, replay/recovery pass,
Friday behavior is preserved, and the published history is live-verified.
Optional trends and unfinished research remain separately tracked.
