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
  build/application-build.json reviewed source/runtime/application provenance
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

The isolated bundle primitive accepts legacy builds without provenance, but the
integrated publication policy rejects them. Supplying a commit string alone is
not proof of build provenance.

## Reviewed source build recipe

`buildReviewedWeeklyCandidate()` captures a full nominated commit from the
authoritative `prodigic/zivv` repository into private storage outside Git. Release
builds require that commit to be an ancestor of the local `origin/main`; the
runner must refresh and validate that reference before selecting a release.
Preview builds may use a stacked branch commit. Git replacement objects and
inherited Git context are disabled. Raw Git blobs are checksum checked and
written directly, preserving committed bytes rather than applying archive or
checkout attributes. Linked files, submodules and nonportable collisions fail.

The recipe installs the captured lockfile with `npm ci --ignore-scripts`, then
compiles the application and ETL from that captured source. It records source
tree/blob inventory, lockfile, Node/npm versions, compiled ETL inventory, Vite
inventory, base path and every application artifact hash. It verifies source
bytes after compilation and the complete compiled ETL inventory before import,
before export and after export. A changed executable fails before the candidate
completion marker. Reviewed configuration comes from the captured commit;
generated frozen-edition state is captured explicitly from operator storage.

`readPublishableCandidate()` requires the trusted candidate ID, expected commit,
base path and purpose. It authenticates and rechecks the bundle, then returns
verified public buffers. Preview provenance cannot authorize production release.
No raw source, private database, build checkout, receipt or key belongs in the
public publication tree.

Operator commands (explicit paths are placeholders):

```sh
npm run candidate:build -- --source-commit <full-sha> --purpose preview \
  --base /zivv-test/ --npm-cli <npm-cli.js> --edition-id <YYYY-MM-DD> \
  --output-dir <private-operator-directory>
npm run candidate:verify -- --source-commit <full-sha> --purpose preview \
  --base /zivv-test/ --directory <candidate-directory> --candidate-id <trusted-id>
```

Set `ZIVV_LEDGER_HOME` to the existing permanent operator store. These commands
require the shared SQLite store and existing recovery key. Build briefly captures
the ledger, matching authenticated encrypted snapshot and existing edition state
under the store lock; compilation/export happen privately afterward. They do not
import, acknowledge an edition, deploy or activate a scheduler.

### Read-only rehearsal, 2026-10-14

The reviewed application/ETL commit
`05e8b11552c0070407419a3dee8c130cffbe2001` built with Node 24.19.0 and npm 11.6.0.
The frozen 2026-10-09 edition produced 55 verified public files and candidate
`062ee30d35fd75f96d382c48a8b10112c386823b00af3cdcb2d72ed26633988f`.
Independent CLI verification passed; requesting release purpose for that preview
candidate failed. Ledger digest remained
`5d2360394cf1242b9cc98e2124a850885cf4df0e49e75eb9249783812e38d0c4`,
with 4,641 events, 8,678 artists and 656 venues. No publication or cutoff changed.
The controlling recipe was work in progress during this rehearsal; this is build
and verification evidence, not a completed unattended Friday run.

## Remaining integrated delivery contracts

- Integrate the reviewed build recipe with the resumable runner and record its
  candidate ID in the journal. Refresh authoritative release references and
  select approved code/configuration contexts before side effects.
- Full recovery must also cover journal, receipts and raw/prepared evidence;
  a candidate's paired catalog/configuration snapshot is not the complete
  operator recovery bundle (#36).
- Required checks bind to candidate identity. Promotion uploads those same bytes;
  live verification precedes edition acknowledgement. Prove public rollback
  without rolling back the private ledger.

Existing manual import, weekly preparation and ETL commands remain available.
This checkpoint changes no importer, publication cutoff, scheduler or deployment.
