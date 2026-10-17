# Steve List October 16, 2026 import

The confirmed October 16 edition arrived at 5:40 p.m. Pacific. Exact email text,
source hashes, prepared rows, reconciliation evidence, merged legacy archives
and resumable automation progress remain in ignored operator files. The shared
SQLite ledger outside worktrees is authoritative. The public export is paired
with an authenticated, restoration-verified encrypted snapshot.

## Source accounting

All 1,086 dated source headers are accounted for. Eight non-show rows are
explicitly excluded: three membership meetings, volunteer orientation,
Cholos Vs. Vampires, two Emo Night entries and a daylight-saving reminder.
The 1,078 remaining rows yield 1,077 accepted canonical observations. The source
repeats the same Cheekface date/venue/time with alternate support billing;
both original rows remain in the private source and the duplicate is audited.
Unverified support spellings and alternate billing remain tracked in #4.

Corrections restore the November 3 cancellation header without dropping the
Sex Mex bill. The importer now recognizes an explicit whole-show `(cancelled)`
venue note, including an otherwise sold-out bill, while a cancelled support act
does not cancel the entire event. A failing regression test reproduced the old
confirmed status; the corrected importer uses version 5 receipts.

Charm World's set time and Finish Ticket's almost-final-show annotation are
retained as event notes while preserving their established artist identities.
Complete-row corrections run after wrapped email rows have been collapsed;
only unrecognized date headers are repaired before that boundary. The exact
raw source remains unchanged.

## Reconciliation and weekly state

The import adds 85 shows and updates 49 existing listings, including the explicit
cancellation. Four reviewed identities retain their original event IDs: the
reordered Lanesplitters bill, the Mabuhay bill now specifying Upstairs, the
expanded Noble Cinema bill and the retimed Bridge City Sinners bill. Their
field changes retain provenance. Upstairs remains a distinct venue rather than
a global alias of the older generic room.

Reviewed Gilman Brewery Company and 9 Lives variants resolve to their existing
venues. Source cities and already reviewed locality metadata remain intact;
Geographer remains local. Seven empty venue metadata fields are filled only
from the existing guarded, reviewed venue-details registry.

The catalog contains 4,726 events, 8,843 artists and 661 venues. All 4,641 prior
event IDs, slugs, show dates and first-added dates survive, as do all original
artist and venue IDs. No new same-date/venue/headliner duplicate or past-dated
show is introduced. Two pre-existing duplicate bill groups remain outside this
edition's reconciliation scope.

The October 16 edition freezes 85 additions from the last successfully published
cutoff through `2026-10-17T01:00:12.855Z`. The CLI receives the original ISO string
directly through Node, avoiding PowerShell's automatic date conversion and loss
of timezone/precision. Existing published windows are unchanged. Publication
state advances only after successful deployment and live verification.

An unpublished preparation attempt was restored from the verified pre-import
checkpoint with an exact shared-revision guard after preview exposed misplaced
wrapped-row annotations. A draft cutoff affected by shell date conversion was
also corrected before release. No faulty export was published.

## Validation

All 23 manifest-listed files pass byte-size and SHA-256 checks. Identity,
first-added date, reference, weekly membership, cancellation, corrected time,
room and annotation checks pass. Encrypted recovery verification reconstructs
the catalog and validates database integrity and foreign keys.

All 337 ingestion and affected component tests pass, including the cancellation
regression. Application/tooling TypeScript, lint, formatting and the production
build pass. The rendered newsletter is reviewed in preview and raw/copy modes
before publication. Raw inputs, reports, keys and cleartext catalog data remain
outside Git.

Delivery is tracked in [issue #63](https://github.com/prodigic/zivv/issues/63).
Existing follow-ups cover reusable preparation (#10), performer ambiguities
(#4), and legacy multi-location venue reconciliation (#5/#12). These are not
represented as completed by this edition.

## Verified publication

Publication commit:
[`bd3d0ba`](https://github.com/prodigic/zivv/commit/bd3d0ba02cce6ba187a7a9596f2813ac013cf1e7).
The [Pages deployment](https://github.com/prodigic/zivv/actions/runs/38989137812)
succeeded. At 6:05 p.m. Pacific on October 16, all 23 live files matched export
`2026-10-17T01:00:16.194Z`, including 4,726 events and 85 weekly additions.
The live newsletter shows the October 16 heading, intact artist names and
regional city labels. The weekly edition was marked published after those
checks, retaining the same exact cutoff and public membership.
