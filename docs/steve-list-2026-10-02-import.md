# Steve List October 2, 2026 import

The October 2 edition arrived at 4:43 p.m. Pacific. Its original email text is
retained in private operator input and audit files. Import and review use the
authoritative shared SQLite ledger; raw email, cleartext ledger snapshots,
operator keys and reports remain outside Git.

## Accounted source and resulting catalog

- 1,211 source entries; eight programming-only entries explicitly excluded using
  the existing non-performer list. These are four Gilman membership meetings,
  Castro Street Fair, Cholos Vs. Vampires, Emo Night and KEXP Vinelands Live.
- Remaining rows reconcile to 1,201 accepted canonical observations, including
  duplicate source listings. No unresolved import matches remain.
- 177 net new shows and 57 source-updated shows; the public catalog contains
  4,495 events. The October 2 weekly edition contains the 177 additions since
  the last verified published September 25 cutoff.
- All 4,318 prior event IDs, slugs and first-added dates remain intact. Three
  reviewed malformed legacy times were corrected. The Fred Armisen October 28
  duplicate was consolidated into its original identity with retained source
  history and a redirect.
- No newly imported event is incorrectly dated before this edition, and no new
  event duplicates an existing bill on the same date and at the same venue.

## Importer corrections

The dated weekly importer now places upcoming spring and summer listings in
the following year when their month/day precedes the issue date. Its previous
six-month heuristic could assign those shows to the past. The importer identity
is bumped to version 4 because date interpretation changed.

An observation omitting a show time, or supplying one for a previously untimed
bill, now retains the unique same-date, same-venue, same-headliner, full-lineup
Steve List identity. Known time values survive omissions. Provider/session
identities and multiple-show markers remain guarded; two possible performances
produce an explicit review item rather than an automatic merge.

Source corrections restore the missing Sackerson December 5 weekday and the
Fred Armisen October 28 time separator, and tolerate the updated Ivy Room and
Castro Street Fair formatting. The complete raw source remains unmodified.

## Validation

Regression tests reproduce and cover both year drift and omitted-time duplicate
creation, including ambiguous multiple performances. Ingestion/component tests,
lint, application and Node TypeScript checks, formatting with the package-lock
Prettier version, production build, exact manifest file sizes/checksums, retained
identities and date-added windows are checked before release. Encrypted recovery
verification reconstructs the shared catalog and checks database integrity.

The final ingestion/component suite passed all 216 tests. Lint, both TypeScript
configurations, the locked formatting check, production build and all 22
manifest-listed output files passed. The production preview rendered the
October 2 newsletter and the updated catalog without browser errors.

Reusable audited preparation of wrapped emails and non-performer exclusions is
tracked in [issue #10](https://github.com/prodigic/zivv/issues/10). The Beads CLI
was unavailable in this session, so the follow-up was filed in GitHub.

Two same-date bill groups remain among pre-existing event IDs; this import adds
no duplicate bill to those groups. Broad historical catalog reconciliation is
separate from this weekly update.

The initial unpublished export was rolled back using the verified encrypted
pre-import snapshot and an exact shared-revision guard after validation exposed
year drift. The corrected import, repairs and export were then rerun. No faulty
export was published.

## Verified publication

Publication commit:
[`4c6472f`](https://github.com/prodigic/zivv/commit/4c6472f1dfebd87efb943b18fb86b848ef224c9c).
The [Pages deployment](https://github.com/prodigic/zivv/actions/runs/37080803437)
succeeded. At 5:11 p.m. Pacific on October 2, the live manifest and all 22 listed
files matched export version `2026-10-03T00:05:32.592Z`, with 4,495 total events
and 177 October 2 additions. The live homepage and newsletter rendered without
browser errors. The weekly edition was marked published after this verification.

Live results: [Zivv](https://www.prodigic.com/zivv/) and
[Bay Area newsletter](https://www.prodigic.com/zivv/newsletter/bay-area).
