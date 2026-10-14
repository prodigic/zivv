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

## Captured configuration and sealed bundles

New exports also include `sourceConfigurationSha256`. The complete fixed inventory
records every effective configuration file as exact bytes or explicit absence.
ETL applies the captured bytes through the same metadata functions used by release
validation, and rejects workspace configuration changes before replacing public
output. Search and city indexes use the export observation time so a later retry
does not recompute different answers merely because time passed.

`buildCandidateBundle()` copies the supplied ledger, authenticated snapshot,
configuration and compiled application bytes before yielding. It exports through
an isolated JSON workspace in private storage outside Git. Each bundle contains:

```text
candidate-.../
  workspace/data/              captured ledger and reviewed configuration
  workspace/public/            checked compiled site and generated dataset
  recovery/ledger.snapshot.enc matching authenticated snapshot
  build/vite-manifest.json     complete compiled application inventory
  candidate.json              identity and exact artifact hashes
  complete.json               completion marker, written last
```

`sealReleaseCandidate()` requires ledger/snapshot/configuration/frozen-edition
agreement. It checks canonical identity/history, reviewed metadata, summaries,
monthly descriptors and all derived search/index/locality/recent-additions data.
It hashes every public file, rejects private/unknown/unlisted artifacts, and
requires the complete Vite inventory, including lazy imports and CSS/assets.
`ZIVV_CANDIDATE_BUILD=1` enables Vite's private `.vite/manifest.json` output; ordinary
builds keep their existing output. Move that inventory into the private bundle,
not the publication directory.

`readVerifiedCandidateBundle(directory, recoveryKey, expectedCandidateId)` requires
the candidate ID from the trusted run receipt, checks the completion marker,
authenticates recovery and rechecks captured inputs/public files. It returns the
verified bytes in memory; publication must upload those buffers, avoiding a later
unchecked reread. Changed, missing, added, linked or incomplete artifacts fail.
No recovery key is persisted in the bundle, and private files are outside its
publication subtree.

These APIs are implemented and tested. The runner must still establish that the
supplied application build and `sourceCommit` came from the same reviewed code,
record the candidate ID in its journal, and integrate validation/promotion.
Supplying a commit string to this library is not proof of build provenance.

## Remaining integrated delivery contracts

- Capture a reviewed source checkout and build provenance, then integrate the
  bundle APIs with the resumable runner. Copy configuration from that reviewed
  context and explicitly version generated frozen-edition state.
- Full recovery must also cover journal, receipts and raw/prepared evidence;
  a candidate's paired catalog/configuration snapshot is not the complete
  operator recovery bundle (#36).
- Required checks bind to candidate identity. Promotion uploads those same bytes;
  live verification precedes edition acknowledgement. Prove public rollback
  without rolling back the private ledger.

Existing manual import, weekly preparation and ETL commands remain available.
This checkpoint changes no importer, publication cutoff, scheduler or deployment.
