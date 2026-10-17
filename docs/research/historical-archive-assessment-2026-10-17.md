# Historical archive: inventory and initial parser diagnostic

Checkpoint for [#66](https://github.com/prodigic/zivv/issues/66), following the
[historical enrichment plan](../historical-steveslist-plan.md). This completes
the initial inventory, not historical replay, canonical matching or a backfill.

## Inventory

| Measure                                        | Observed result                              |
| ---------------------------------------------- | -------------------------------------------- |
| Files                                          | 83 text files                                |
| Exact source bytes                             | 11,793,209                                   |
| Strict UTF-8 decoding                          | 83 valid, none rejected                      |
| Unique resolved header edition dates           | 83                                           |
| Header date range                              | March 14, 2025–October 9, 2026               |
| Adjacent edition intervals                     | 82 intervals, all exactly seven days         |
| Exact duplicate files / duplicate header dates | None / none                                  |
| Filename/header disagreements                  | 50; filenames are one day after their header |

The archive covers every weekly header date in that interval. This does not prove
that every revised delivery or every scheduled show was captured. Filesystem
timestamps are copy times, not verified delivery timestamps. Preserve filenames
and header dates separately; do not rename or rewrite source files in place.

SHA-256 hashes and sizes were captured for every file. An independent second read
matched all source hashes. The private inventory content is addressed by
`6335ceafed7b546fabfe35af4cc412b3b5e840ada2d910956fc40975835ddc65`.
Private reports live in the operator's local Zivv archive-assessment directory,
outside Git, with directory access restricted to the operator.

## Existing-preflight diagnostic

Ran the existing deterministic `preflightSteveContent` from the compiled current
source against each edition with a fresh empty in-memory catalog and current
aliases/corrections. No canonical ledger was loaded, saved, imported or restored.
The in-memory catalog remained unchanged for every edition. This is not a
chronological import or a coverage comparison against the canonical catalog.

| Classification across all editions           | Observations |
| -------------------------------------------- | ------------ |
| Rows examined                                | 113,014      |
| Accepted row observations                    | 91,256       |
| Programming-only rows                        | 269          |
| Exact duplicate rows within editions         | 37           |
| Invalid rows under current preflight         | 21,452       |
| Complete editions producing prepared batches | 0 of 83      |
| Unhandled preflight exceptions               | 0            |

The four row classifications sum exactly to the rows examined. Weekly listings
repeat shows, so these are observations, not unique shows. An accepted row does
not establish a correct canonical identity, year or event match. Empty-catalog
results can differ from known-name-assisted canonical validation.

Common diagnostics were unclassified continuations after a venue, calendar/date
or weekday-token errors, incomplete parsed events and missing explicit venue/city.
Diagnostics may overlap per row, so their counts are not loss or unique-error
counts. No rejected row was discarded or silently accepted. All per-edition
reports, row/line evidence and error details remain private.

The private preflight summary is content-addressed by
`cc98235651ffcf14e1e2a265d6d5f7e1342a722434fd077090fc1d822297e33d`.
Reports bind source hashes and preflight rules hashes. Retain these together with
the diagnostic scripts and source revision for reproducibility. Source/application
baseline was the reviewed main tree used for PR #68; the added policy document
does not change parser behavior.

## Next checkpoint

1. Reproduce representative failures with minimal synthetic fixtures, separating
   source defects from parser limitations. Keep current Friday semantics intact.
2. Establish any historical preparation rules explicitly; do not weaken strict
   preflight merely to make all files pass. Capture every source-row disposition.
3. Replay accepted editions chronologically in an isolated private store, using
   versioned rules and exact source dates, with resumable receipts.
4. Compare proposed identities/fields to a consistent canonical baseline. Report
   unique coverage gained, exact matches, conflicts, uncertainty and export growth.
5. Review the report and select the first backfill scope before live application.

No historical shows were added to the site, no current added dates or weekly
membership changed, and no production recovery or publisher operation ran.
