# Reliable Friday delivery plan

Agreed with the operator on October 14, 2026. Tracking issue: [#38](https://github.com/prodigic/zivv/issues/38).
This is the approved delivery contract and implementation sequence. Recording it does not activate a scheduler, migrate hosting, authorize new research spending, or complete implementation.

## Release contract

- Operate unattended once activation prerequisites and rehearsals pass. Ambiguous core data requires review; routine successful runs require no human approval.
- Use `America/Los_Angeles` for all Friday and Sunday boundaries, including daylight saving changes. Prepare early arrivals immediately, but publish the weekly edition no earlier than Friday midnight. Publish on verified source arrival thereafter.
- If the expected source has not arrived by Friday at 6 p.m. Pacific, alert the operator. Accept late editions and verified corrections through the end of Sunday Pacific (before Monday midnight); later deliveries require review. If a source is missing or invalid, retain the last verified release and report the failure.
- Preserve exact private sources, stable IDs/slugs, source observations, redirects, original first-added dates and frozen weekly membership. Known programming-only rows and exact duplicates may be excluded with explicit row accounting. Unresolved core artist/venue/date data blocks the edition; do not silently drop shows.
- Missing optional photos, posters, reviews, links or maps does not block valid show publication. Withhold incorrect/ambiguous metadata. Reapply existing reviewed metadata and persist new research tasks. Unattended AI research remains disabled until runtime and research budget are selected.
- Publish only an exact validated candidate whose export and encrypted backup agree with its authoritative ledger revision. Advance the publication cutoff only after live verification. A successful import, build or push alone is not publication success.
- If live verification fails, restore the previous verified public release and alert the operator. Retain the newer private ledger, source history and import receipts for diagnosis; public rollback is not database rollback.
- Send deduplicated actionable failures and one concise success receipt per edition to an agreed email destination. Success receipts include the live link, counts and remaining gaps. Independent monitoring must detect a runner that never starts.

## Architecture and ownership

Formal ETL sits inside a resumable release orchestrator:

```text
Acquire and preserve exact private source
  -> Extract, normalize, validate and reconcile
  -> Transactionally load authoritative SQLite
  -> Prepare frozen weekly edition; apply reviewed metadata
  -> Export static JSON and matching encrypted recovery snapshot
  -> Validate exact candidate
  -> Deploy to GitHub Pages
  -> Verify live dataset, routes and ordinary cached/fresh clients
  -> Record publication success and advance cutoff
```

Each stage has explicit inputs, outputs, receipts, revision identifiers, transitions and retry behavior. A committed import survives a failed publication; retries resume the remaining work without importing twice. Define edition correction semantics, including newly announced shows after membership is frozen, before automating them. No additions may disappear between editions. Keep weekly edition state, metadata/configuration, candidate artifacts and encrypted recovery material traceable alongside the ledger revision.

GitHub remains authoritative for code, issues and reviews. GitHub Pages hosts the public site. The public prodigic/zivv-test repository is an artifact-only preview destination, approved by the operator on October 14, 2026. Automation may publish validated data updates; application code changes require review. Keep SQLite authoritative and static JSON as the browser delivery boundary. Review useful parts of the August experiment in #40; a database/framework migration is not required for this plan. #42 records the stage contracts; #43 covers GitHub Pages preview and future domain cutover.

## Every checkpoint preserves Friday importing

Every implementation issue must leave the existing manual import and publication path working. New automation is optional until verified. Stopping after any step must leave exact, tested commands for completing Friday's release. This guarantees manual operability, not unattended operation before all prerequisites are complete.

For every applicable checkpoint:

1. Run a representative edition through the supported path in an isolated private test store. Do not import synthetic fixtures into the live ledger or reset the production weekly cutoff for a test.
2. Replay it and prove stable IDs, original first-added dates, source history and weekly membership are preserved.
3. Prove export and encrypted backup correspond to the intended ledger revision; retain configuration/edition state needed for recovery.
4. Interrupt and resume the affected stage, showing no duplicate imports or lost additions.
5. Keep operator commands and fallback instructions current. If a script is replaced, retain a compatible entry point until its replacement is verified.
6. Apply relevant code/data quality checks. Repair existing failures before making new gates mandatory. Implement live verification/recovery support before enforcing gates that depend on it.

Preview work must leave GitHub Pages publication available. Promote a candidate only after GitHub preview checks and a return-to-previous-release drill pass. Keep deployment candidate identity intact across both hosts.

## Implementation order and stop points

| Stage | Deliverable and dependencies                                                                                                                                                                               | Working path if stopped                                                                      |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| 0     | Define contracts (#42); use current commands and retained fixtures as evidence.                                                                                                                            | Existing manual import/export/publication.                                                   |
| 1     | Deterministic wrapped-email preflight and row accounting (#10).                                                                                                                                            | Existing commands plus independently usable preflight.                                       |
| 2     | Resumable orchestration (#31), optional durable metadata queue (#32), candidate validation and release-gate support (#39). #31 depends on #10 and #42; development does not depend on scheduler selection. | Manual stage commands and resumable command; new dependent gates stay optional until proven. |
| 3     | Build a GitHub Pages preview in prodigic/zivv-test (#43); implement candidate publication (#35) behind verified contracts.                                                                                 | Current GitHub Pages remains usable; preview is optional.                                    |
| 4     | Live verification, exact candidate promotion and public rollback (#36); enforce supported fail-closed gates (#39).                                                                                         | Documented manual publication, verification and recovery.                                    |
| 5     | Automatic acquisition (#30), eventual runtime/scheduler (#29), monitoring/retries/email (#37). Select runtime/budget/credentials before activation.                                                        | Manually supplied source remains supported; scheduler disabled until final rehearsals.       |
| 6     | End-to-end rehearsal, duplicate/missing-source/interruption/deployment failure drills and fresh-environment recovery (#38). Observe the first two scheduled Friday editions.                               | Verified manual path remains available throughout observation and later operation.           |

Production promotion follows successful preview/live/recovery checks. Attach the future custom domain afterward. Optional collectors and bounded AI review (#33–#34) follow explicit runtime/budget decisions. Metadata coverage work can proceed separately without blocking the core delivery path. Newly discovered core-data failures are still publication blockers.

## Delegation plan

Use the [ingestion test scope policy](ingestion-test-policy.md) to distinguish
routine and targeted checks from full recovery milestones. This does not remove
the recovery acceptance requirements or activate automation.

Terra/Luna assignments below are candidates for small measured trials, not proven model choices or authorization for automatic model substitution. Use available requested models; ask before substituting unavailable ones. Require bounded inputs, structured outputs or specific files, evidence, checks performed and explicit unresolved cases. Share cached source evidence and separate file ownership.

Sol high owns architecture, ambiguous identities, transaction/concurrency/cutoff semantics, credential permissions, canonical repairs, integration and promotion decisions. Smaller-model research agents produce candidates; they do not directly write unchecked canonical facts. Audit the first batch, periodically sample positive and negative results, and review every ambiguous identity or canonical correction. Escalate systematic extraction defects across the affected method. Report accepted outputs, failures, rework and actual token telemetry when available; do not invent cost measurements. Trial fixture creation, inventories and official-link extraction first. Unattended research remains disabled pending the deferred decisions.

| Issue/task               | Bounded smaller-model subtask                                                                            |
| ------------------------ | -------------------------------------------------------------------------------------------------------- |
| #10 Preflight            | Synthetic wrapped-email fixtures, expected duplicates/exclusions, row-accounting checks.                 |
| #29 Runtime              | Target prerequisites, environment-variable/configuration examples, restart checklists.                   |
| #30 Acquisition          | Sender/edition fixture filtering, hashes, duplicate detection, private-log redaction tests.              |
| #31 Orchestration        | Approved stage-receipt serialization, interruption/replay fixtures, transition-table tests.              |
| #32 Queue                | Missing-field inventories, deduplication, priority/coverage reports.                                     |
| #33 Collectors           | Parsers for supplied official-page fixtures, cache/hash comparison, bounded fetch-failure outcomes.      |
| #34 Review               | Evidence/URL/date checks, reproducible samples, discrepancy reports; no identity acceptance.             |
| #35 Publication          | Candidate manifests, revision comparisons, staged-file allowlists/forbidden-path checks.                 |
| #36 Verification         | Checksums, route smoke checks, recovery fixtures and observed drill records.                             |
| #37 Monitoring           | Message templates, alert deduplication and approved missing-heartbeat fixtures.                          |
| #38 Acceptance           | Acceptance checklist, rehearsal evidence and prerequisite reports.                                       |
| #39 Gates                | Tolerated-failure inventory, approved narrow workflow edits, failure/artifact checks.                    |
| #42 Contracts            | Existing command/input/output inventory, sample receipts and conformance checks.                         |
| #43 GitHub preview       | Approved CI configuration, base-path inventory, preview deep-link/asset fixtures.                        |
| #17 Artwork              | Small venue batches of official image candidates with exact artist/date/venue evidence.                  |
| #18 Links                | Observed destinations from verified official anchors, URL deduplication, ownership gaps.                 |
| #19 Reviews              | Cited passages, release titles/authors/dates and evidence-constrained summary candidates.                |
| #20 Maps                 | Verified coordinates, range/attribution checks and precision labels.                                     |
| #21 Venue details        | Exact-ID address/website candidates, normalized formatting and primary citations.                        |
| #22 Photo UI             | Components from approved field contracts, dimensions, lazy loading and failure fallbacks.                |
| #23 Photo gaps           | Small identity-anchored batches, photo/artwork classification and explicit outcomes.                     |
| #24 Photo policy         | Inventory stated licenses/permissions/credits; policy decisions remain with operator/main agent.         |
| #25 Bandcamp             | Observed embed IDs, credited-release checks, structured candidates and player fixtures.                  |
| #26 Identity/locality    | Side-by-side evidence and crosswalk candidates; reviewed canonical repairs only.                         |
| #27 Knights conflict     | Dated evidence packet comparing addresses and exact bills.                                               |
| #28 DragonForce conflict | Dated evidence packet comparing venue/date/support lineup.                                               |
| #4 Performers            | Supplied billing-fragment classification, parser reproductions and approved regression fixtures.         |
| #5 Venue splits          | Affected-event/source-location inventory and evidence grouping.                                          |
| #12 Legacy venues        | Event/location crosswalk candidates and unmatched records; coordinate overlap with #5.                   |
| #9 Tests                 | Collected/omitted-suite inventory, isolated fixture/setup fixes and uncovered-behavior reports.          |
| #40 Architecture         | Old/current module crosswalks, dependency and contract-test inventory; Sol high decides recommendations. |

## Deferred decisions and activation gates

- Initial runtime (operator decision October 17): this Windows machine, until replacement hardware or a cloud account is selected. Keep implementation portable. Host availability, secure source credentials, scheduling/restart behavior and activation rehearsals still require implementation and verification.
- Hosting/runtime and AI research budgets; enforce them before unattended research activation.
- GitHub Pages preview repository is prodigic/zivv-test, public and approved. Verify deployment credentials, branch permissions and /zivv-test/ base path before publishing artifacts; production remains /zivv/.
- Source-access credentials, exact expected edition identification and credential renewal.
- Notification account/destination (operator decision October 17): the same Gmail account receiving Steve's List. Keep its address and credentials in private operator configuration. Unattended credentials, delivery/reconciliation and the independent monitoring provider still require setup and verification.
- Fresh-environment restoration of encrypted ledger plus versioned weekly/configuration state, with a separately stored recovery key.
- Representative successful end-to-end rehearsal and failure drills, followed by two observed Friday editions.

Until these gates pass, the operator uses the preserved manual path. No schedule, external notification, hosting cutover or AI spending is activated by this document.

## Existing references

- [Shared ledger and encrypted recovery](shared-ledger.md)
- [Quarantined recovery runtime preparation](recovery-runtime-preparation.md)
- [Retained same-run import admission](recovery-import-admission.md)
- [Validated-candidate recovery through dispatch](recovery-candidate-admission.md)
- [Frozen-run recovery through candidate validation](recovery-frozen-admission.md)
- [Captured accepted-dispatch reconciliation](recovery-dispatch-admission.md)
- [Verified release acknowledgement recovery](recovery-verified-admission.md)
- [Authenticated frozen-result handoff boundaries](recovery-result-chain.md)
- [Frozen-result recapture and intermediate fencing](recovery-result-recapture.md)
- [Weekly editions](weekly-editions.md)
- [Durable Gmail acquisition handoff contract](steve-gmail-durable-handoff.md)
- [Authenticated Gmail batch recovery plan](gmail-batch-recovery-plan.md)
- [Architecture experiment review](architecture/2026-08-reorganization-review.md)
- [Enrichment quality protocol](research/enrichment-quality-protocol.md)
- [GitHub backlog](https://github.com/prodigic/zivv/issues/38)

Some historical documentation may describe older storage or deployment paths. Verify against current maintained commands; #42 includes reconciling those references as contracts are formalized.
