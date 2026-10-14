# Release candidate identity

Implementation checkpoints for #35 and #39. The [Friday plan](friday-delivery-plan.md)
and [stage contracts](weekly-stage-contracts.md) remain the acceptance contract.

## Captured ledger revision

New ETL exports include `manifest.sourceLedgerRevision`, the SHA256 digest returned
by `ledgerDigest()` for the exact ledger loaded under the ingestion lock. The
encrypted snapshot uses this same canonical logical digest. Reviewed metadata
and computed summaries apply to clones; they do not alter the captured ledger.

The field is optional in the browser type to keep older public exports readable.
An unattended publication gate must require it, authenticate the corresponding
encrypted snapshot with the private recovery key, and compare its decoded logical
digest. A matching catalog count, ledger version string or manifest timestamp
alone does not establish revision agreement. An isolated correction/export test
demonstrates that a previously valid snapshot can differ from the next export.

This field establishes an input identity. It does not by itself validate every
output or authorize deployment. A publisher must bind checked public bytes and
the snapshot to a sealed candidate and reject changed files before promotion.

## Remaining candidate contracts

- Capture exact source commit, reviewed configuration bytes and frozen edition
  alongside the ledger revision. Stage export from those captured inputs so
  concurrent workspace edits cannot mix configuration versions.
- Include every effective metadata input: venue sources, location corrections,
  details, maps, posters, artist reviews/links, slug redirects, local artist
  verification and weekly edition state. Existing manifest `sourceFiles` hashes
  cover only a subset; they are not yet a complete configuration identity.
- Hash all public artifacts, including search and local-artist files omitted from
  the current `chunks` listing. Keep a strict publication allowlist that excludes
  sources, reports, databases, keys, operator configuration and recovery state.
- Keep encrypted recovery material paired privately with the public candidate.
  Full recovery must also cover journal, receipts, raw/prepared evidence and
  weekly/configuration state (#36).
- Required checks bind to candidate identity. Promotion uploads those same bytes;
  live verification precedes edition acknowledgement. Prove public rollback
  without rolling back the private ledger.

Existing manual import, weekly preparation and ETL commands remain available.
This checkpoint changes no importer, publication cutoff, scheduler or deployment.
