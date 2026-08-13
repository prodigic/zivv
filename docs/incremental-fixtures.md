# Incremental ingestion fixtures

The `data/steve/` directory contains historical snapshots materialized from the Git history of `data/latest.txt`. They are source snapshots for testing incremental ingestion, not weekly partitions and not production output.

## Ordered fixture sequence

Process these files in chronological order:

1. `week-251010.txt`
2. `week-251024.txt`
3. `week-260109.txt`
4. `week-260417.txt`
5. `week-260424.txt`
6. `week-260508.txt`
7. `week-260807.txt`

The files must remain unchanged. Tests should discover them by the `week-*.txt` pattern and sort by the filename date rather than hard-coding a separate test for each file.

## Required test behavior

The ingestion harness should:

- start from an empty target;
- process each snapshot in order;
- report added, updated, removed, unchanged, malformed, and deduplicated records;
- preserve stable event, artist, and venue identities across snapshots;
- retain source filename, source line, raw text, first-seen, and last-seen provenance;
- reprocess each snapshot and assert idempotence;
- compare generated projections by stable key rather than array position;
- fail with the snapshot filename and source line when a contract breaks.

## What the fixtures are for

These snapshots are the shared test data for Workstreams A, D, and E:

- Workstream A uses them to establish contract and delta tests.
- Workstream D uses them to verify parser/normalization boundaries and repeated ingestion.
- Workstream E uses them to verify DuckDB staging, canonical upserts, SQL quality checks, and export equivalence.

They should not be used as a reason to modify current production `data/` inputs or generated `public/data/` output during a unit test.
