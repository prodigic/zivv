# Weekly ETL and release stage contracts

Contract checkpoint for #42, based on main `281504d76e60948b84faea1b389f591c084d9511`, October 14, 2026. See the [approved plan](friday-delivery-plan.md), [glossary](GLOSSARY.md) and [architecture decision](adr/0001-weekly-etl-release-boundary.md).

This defines the required orchestrator behavior. Existing commands below are implemented; the stage journal, automatic acquisition, candidate promotion and GitLab deployment are future work in #30–#39/#43. No scheduler, storage migration or hosting switch is introduced at this checkpoint.

## Stage boundaries

| Stage                    | Inputs                                                                             | Durable result / acceptance                                                                                                            | Retry and failure                                                                                                                                                        |
| ------------------------ | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Acquire (#30)            | Expected sender/feed, dated edition, arrival window, credentials                   | Exact private raw source; source/message identity; content hash; original observation time; correction relationship                    | Duplicate deliveries reuse evidence. Missing/late source alerts; unrelated/older messages are not imported.                                                              |
| Prepare (#10)            | Raw source, versioned normalization rules and explicit exclusions                  | Prepared batch plus raw-to-prepared row accounting, exclusion/duplicate reasons and hashes                                             | Same evidence/config yields same preparation. Unknown malformed/core-ambiguous rows block; no silent omission.                                                           |
| Reconcile (#31)          | Prepared batch, current ledger revision, exact artist/venue anchors                | Dry-run report tied to source/config/revision; conflicts and review outcomes classified                                                | Stale revision invalidates review. Core ambiguity requires resolution; optional enrichment gaps do not block shows.                                                      |
| Load (#31)               | Reviewed batch, original observation time, guarded current revision                | Transactional import receipt, unchanged existing first-added dates/IDs, new committed ledger revision and private report               | Reuse matching receipt on replay. Ledger commit may succeed before report/backup/journal writes; detect and recover that state, never blindly reimport.                  |
| Freeze edition (#31)     | Committed ledger, edition ID and agreed added-date cutoff                          | Immutable half-open window, membership and source version in versioned weekly state                                                    | Existing ID reuses original window/membership/version. Different cutoff, skipped draft or out-of-order publication is rejected.                                          |
| Enrich / queue (#32–#34) | Exact identities, reviewed registries, missing/stale metadata                      | Guarded reviewed metadata and persistent research queue; provenance and explicit unresolved outcomes                                   | No collector or AI availability needed for initial release. Do not fabricate facts or mutate canonical identity from unchecked research.                                 |
| Export (#35)             | One captured ledger revision, frozen edition state, exact reviewed config and code | Complete static JSON/manifest plus matching verified encrypted ledger snapshot; checksums, config/edition identity and source revision | Stage outputs in candidate storage; interrupted export is not deployable. Reject a changed input revision/config and build a new candidate rather than mixing artifacts. |
| Validate (#39)           | Immutable candidate, expected identities/references, required test policy          | Passed checks bound to exact code/dataset/artifact hashes                                                                              | Failed required checks retain last good public release. Checks changing candidate bytes invalidate earlier success.                                                      |
| Deploy (#35/#43)         | Exact validated candidate, release authority, destination credentials              | Deployment ID, immutable artifact identity and GitHub/GitLab commit association                                                        | Resume by deployment identity; do not publish a newer unvalidated rebuild. Serialize promotion across runners.                                                           |
| Verify (#36)             | Deployment result, candidate hashes, intended destination                          | Live manifest/file matches; current/future/weekly routes and cached/fresh client checks; previous-good recovery evidence               | Failed checks restore prior verified public artifacts and alert, without restoring an old private ledger.                                                                |
| Acknowledge (#31/#37)    | Successful live verification receipt for the exact edition/candidate               | Published edition/cutoff, completion receipt and deduplicated success notification                                                     | Idempotent acknowledgement; failure here resumes acknowledgement, not import/deploy. Recheck live identity if the destination changed.                                   |

## Identity and private run journal

The journal implementation belongs to #31. Persist it outside Git/public output in permanent operator storage. A minimum versioned record contains:

```text
schemaVersion, runId, sourceEditionId, sourceDeliveryId, correctionOf
rawContentSha256, preparedContentSha256, rulesRevision, observedAtEpochMs
importRunId, reviewedLedgerRevision, committedLedgerRevision
weeklyEditionId, weeklyWindow, frozenMembershipSha256
codeCommit, reviewedConfigSha256, exportDatasetVersion, artifactManifestSha256
encryptedSnapshotLogicalRevision, candidateId, deploymentId, destination
stage, stageStatus, attempt, startedAt, completedAt, safeErrorCode
liveVerificationReceipt, publicationAcknowledgement, notificationReceipt
```

This is a field contract, not an implemented JSON schema. Use explicit null/not-applicable values where a stage has not produced a field; never substitute an arbitrary current timestamp or hash. Do not put secrets, subscriber details, clear sources or recovery keys in public receipts. `ledger.version`, the SHA256 logical ledger digest, frozen edition source version, manifest dataset version and Git commit are distinct identities, not interchangeable strings.

Each stage is `pending`, `running`, `succeeded`, `blocked`, or `failed`. Record an attempt before side effects and write completion atomically afterward. A stale `running` record means inspect the actual receipt/artifact and reconcile the result; it does not mean the operation failed or is safe to repeat. Missing/mismatched evidence blocks resume. `blocked` means unresolved input/review; `failed` means an execution or required validation failure. Optional research outcomes do not turn the release into a failed core-data run.

SQLite protects catalog writes, but does not serialize the entire release lifecycle. #31/#29 must implement one fenced run/promotion owner per production destination, survive process death, and reject a stale owner's acknowledgement. Never rely on one checkout's lock to protect another host. Preserve SQLite's guarded revisions and existing writer transactions beneath this boundary.

The database, report files and weekly-state files are not one atomic transaction today. The current importer writes report/candidate files before the SQLite transaction commits; a failed commit can therefore leave reports without a committed receipt. The transaction commits before its final encrypted-backup synchronization, so a backup failure can leave a successfully committed catalog. Import replay may require `data/ingestion/reports/<report-hash>.json`; a database-only restore can leave a committed run whose report is missing. Future recovery must privately preserve/reconstruct validated reports, raw/prepared evidence and journal state alongside the encrypted database and versioned weekly/configuration files. The reconstruction contract and drills belong to #31/#36; do not change a run ID just to bypass a missing receipt. Commit-before-report is a general future orchestration failure case, not the current importer's write order.

## Weekly corrections and cutoff semantics

- Initial import uses one persisted import observation time; retries retain it. Publisher/message arrival time is separate evidence and must not automatically backdate a newly accepted show's first-added time. Current Steve CLI exposes `--file`, `--root`, and `--dry-run`, but no observation-time flag. The orchestrator must use the maintained API's observation option or add a reviewed CLI option in #31; do not infer historical first-added dates from show dates.
- Freeze the initial edition only after accepted source loading, using an explicit cutoff that includes the intended accepted additions. Current windows are `[start, end)`, so an addition exactly at `end` belongs to the next window. `start` is the last successful publication cutoff; missed weeks accumulate rather than disappear.
- Corrections update show fields and source observations while preserving IDs and first-added dates. A correction release may regenerate the dataset using the same frozen edition membership; it does not prepare a replacement weekly window or advance the cutoff again.
- A newly accepted show after the frozen cutoff can appear on ordinary event pages immediately but belongs to the next weekly additions window. It must not be inserted into already frozen membership or omitted from the next window. #31 must test this with initial publication, late correction, new addition and next-edition preparation.
- Never freeze a future cutoff or freeze while a known pending/review/import-recovery batch carries an import observation time earlier than that cutoff. Otherwise a delayed acceptance can fall outside both the frozen membership and next window. Before freezing, settle all such batches; if unexpected historical evidence arrives after freezing, including while the draft awaits publication, quarantine it for an explicit reviewed carry-forward policy rather than silently backdate, change an existing first-added date or claim automatic weekly coverage. #31 must test delayed review, earlier source arrival, persisted retry timestamps and late acceptance; automatic handling cannot activate until these cases have an accountable outcome.
- A failed publication retains its draft. Retry it before preparing a subsequent edition, consistent with the current weekly state machine. After verified publication, acknowledgement is replay-safe; never skip a draft to manufacture a successful cutoff.
- Candidate bytes cannot change after validation. Marking weekly state published occurs after live verification and may change repository state separately; #31/#39 must prevent acknowledgement/version commits from creating an uncontrolled second candidate or deployment loop. If a status-only public rebuild is required, it is a new validated candidate.

Friday earliest publication and missing-source deadline, Sunday correction boundary and DST handling remain those in the approved plan. Source edition date, show date, first-added date and publication time have separate meanings.

## Maintained manual commands

Run from the intended checkout with Node 24.19.0+ and the selected private operator directory. Verify `npm run ledger:status` first. A missing store is an error; never migrate/restore a stale workspace JSON merely to make a command run. See [shared recovery](shared-ledger.md).

```text
npm run build:etl
npm run ledger:status
npm run ledger:backup
npm run ledger:verify
```

For a reviewed prepared Steve batch, dry-run then inspect the report before committing. Replace placeholders with exact reviewed file/edition values:

```text
npm run import:steveslist -- --file <private-prepared-file> --dry-run
npm run import:steveslist -- --file <private-prepared-file>
npm run weekly:prepare -- --id <edition-id> --cutoff <explicit-ISO-cutoff>
npm run etl
npm run ledger:backup
npm run ledger:verify
```

The current importer reports unresolved reconciliation but can commit accepted subsets. The operator must review core ambiguity before committing; fail-closed orchestration is future #31 work. Do not treat a dry-run's exit code alone as approval. A dry-run skips catalog/report persistence but enters the ingestion lock and may refresh the encrypted backup before/after execution; it is not a guarantee of no filesystem writes. The standalone validated preflight for wrapped emails/programming-only rows remains #10; until then preserve the existing audited preparation procedure.

`npm run validate` is a legacy validator that reads `data/latest.txt`, writes error files and can update aliases; it is not read-only. `npm run merge` combines ledger import with updates to legacy text archives/venue stubs. Do not blindly chain `merge` after the explicit import route; choose and document the intended path. Preserve these commands until verified replacements exist.

Inspect changed files and manifest checksums/references, run applicable tests/build checks, commit only approved public output/configuration/encrypted backup, and publish through the currently maintained GitHub Pages path. GitLab preview/cutover remains #43. Wait for deployment and verify the actual candidate before acknowledging:

```text
node scripts/weekly-edition.js mark-published --id <verified-edition-id>
```

Persist/version the resulting weekly state with candidate linkage; do not assume this command verifies deployment or sends mail. It only marks state. Existing scripts need compiled `dist/lib` modules; a Vite build can clear `dist`, so run `npm run build:etl` again before a later ingestion/weekly command. The export runner has no `--root` option; isolated export fixtures should call `ETLProcessor(fixtureRoot)` rather than point a test at the operator store.

If npm is unavailable but dependencies exist, use a verified Node executable to run `node_modules/typescript/bin/tsc --project tsconfig.build.json`, then the corresponding `scripts/*.js` command directly. Do not bypass a failed compile with stale emitted modules. Set `ZIVV_LEDGER_HOME` explicitly when a sandbox has a different `LOCALAPPDATA`; never print key contents.

## Checkpoint evidence and remaining implementation

October 14 baseline at this checkpoint:

- Restored missing local `undici-types` package at lockfile version 7.16.0 after checking its SHA512 integrity. No dependency manifest/lockfile changes; ETL compile then passed.
- Read authoritative operator ledger: 4,641 events, 8,678 artists, 656 venues, six runs and 283 redirects. Logical revision `5d2360394cf1242b9cc98e2124a850885cf4df0e49e75eb9249783812e38d0c4`.
- `ledger-store.js backup` reported `changed: false`, `verified: true`; `verify` reported the same logical revision, with `restored: false`. The live catalog was not imported, repaired or restored.
- Existing isolated tests: 71 passing across shared-store (14), weekly (8), ledger (26), Steve input (5), historical replay (4), and migration/export (14). They cover process interruption, simultaneous/stale writers, portable-key recovery, receipt replay, frozen membership and synthetic export.
- This is component/isolated recovery evidence, not a rehearsal of automatic Friday delivery, email acquisition, GitLab cutover or full private-report recovery. Those remain activation gates.

Future implementation must exercise each failure edge in the stage table, including commit-before-report/backup failure, live-success-before-acknowledgement failure, stale promotion owner and correction/new-addition membership. #10 is the next implementation checkpoint; #31 implements this contract. #36 covers full recovery, #39 exact-candidate gates, and #43 GitLab preview. Preserve the manual path throughout.
