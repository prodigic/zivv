# Metadata consolidation — October 13, 2026

The completed SF artwork, artist links/reviews, Bandcamp pilot, venue expansion,
event layout and local-band photo research are consolidated into PR #16.
The photo branch is integrated through its Git history; its source inventory and
gallery remain research artifacts. Production photo rendering is future work.
All new follow-up work uses GitHub Issues. The Beads merge only preserves old
historical records and does not restart the retired tracker.

## Standards

GPT-6.1 Sol high found no hard standards violations or merge blocker. It identified
date-validation drift: artist reviews accepted dates normalized by JavaScript,
such as February 30, while other registries rejected them. The review validator
now requires a calendar round-trip. Two regression cases cover invalid research
and publication dates and verify that no artist is modified on rejection.

## Spec

GPT-6.1 Sol high found no actionable spec findings. Canonical event identities,
dates, artist/venue references, first-added history and source observations are
preserved. Reviewed metadata applies before summary export, stale identities are
withheld, and Bandcamp loads only after Listen and unmounts on Close. Coverage
gaps and Friday automation are explicitly remaining work.

## Consolidated evidence

- Shared SQLite revision:
  `5d2360394cf1242b9cc98e2124a850885cf4df0e49e75eb9249783812e38d0c4`.
- Encrypted private baseline guard: passed, zero record changes and violations.
- Encrypted repo snapshot: unchanged bytes, refreshed and verified against the
  current revision; temporary restoration and integrity checks passed.
- Export: 4,641 events, 8,678 artists, 656 venues; canonical entities and event
  history match the pre-consolidation branch. Upcoming summaries are refreshed
  for the current date. All manifest chunk sizes and checksums pass.
- Metadata: 421 show-artwork records; 222 cited artist descriptions; 726 URLs
  across 298 act records; one reviewed Bandcamp album; 598 located venues.
- Photo research: all 526 records have outcomes, including 303 photo selections;
  images were not copied into the public export during consolidation.
- Validation: 334 ingestion/component tests passed before the date fix; the
  focused review suite passes all 12 cases, including the two added regressions.
  Frontend/ETL TypeScript, lint, changed-source formatting, production build and
  both venue export verifiers pass.

The next planning session targets reliable automatic loading and publication
every Friday. Existing ETL reapplication is integrated; automatic acquisition,
delta enrichment, review/quarantine, release orchestration and monitoring are
not claimed complete by this consolidation.
