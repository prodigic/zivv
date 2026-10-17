# Verify Release checkpoint

This implements the Verify stage of the [Friday stage contracts](weekly-stage-contracts.md), following the [reviewed publisher](reviewed-pages-publication.md). It leaves Acknowledge, scheduler activation and the remaining Friday rehearsals separate.

## Acceptance and durable result

The publisher runs `node scripts/run-pages-candidate.js verify-release` after its exact deployment status succeeds. Verification independently polls that deployment again, resolves the exact retained candidate and checks the previous verified public artifact is still recoverable from its immutable Git ref. Missing recovery bytes or an uncertain/nonterminal deployment block verification.

Legitimate empty months and weekly membership use explicit empty states; missing referenced records still block verification. The live inventory sweep uses the closed destination URL, bounded requests, no redirects, cache bypass, retained byte counts and SHA256 hashes. Four requests run concurrently. The manifest is read before and after each complete sweep. The entire sweep runs both before and after browser observations. The empty `.nojekyll` deployment marker remains covered by the retained inventory identity but is excluded from URL checks: the current Pages host returns 404 for that consumed marker.

Browser checks derive expected text and routes from the retained data. They exercise current and later-month events when present, artist and venue pages, the frozen weekly newsletter and the independent rolling additions page. Separate desktop and mobile contexts cover fresh clients and clients whose IndexedDB has actually been populated with the previous release's data. After cache seeding, interception is removed; current checks observe the real site's manifest and visible main content. Public rollback seeds the failed candidate's cache before checking restoration, so it also tests changing back to the previous dataset.

A successful observation writes a flushed evidence file next to the job checkpoint before appending the controller's `verified` transition through compare-and-append. The controller receipt binds the exact destination, release, deployment, inventory and checks. A replay rechecks the site and retains the original accepted controller receipt. No weekly cutoff is acknowledged and no import, ledger restoration or application rebuild occurs.

## Failed checks and recovery

A failed live check after an exact successful terminal deployment appends `failed`, retaining the operation owner in `rollback-required`. The workflow then asks the existing single-shot dispatcher to queue a rollback of that operation's previous verified public artifact. The recovery workflow uses the same retained-byte deployment and live verification path. It cannot recursively queue another rollback.

The originating workflow emits an Actions error and fails even if restoration was queued. A queued recovery is not reported as a completed restoration. Unknown deployment status, stale ownership, unavailable recovery artifacts, a failed CAS or uncertain dispatch remain blocked for reconciliation; none grants permission to create a blind replacement deployment. GitHub's ordinary failed-workflow notification is the alert at this checkpoint. Provider-neutral notification delivery, deduplication and the independent missed-run watcher remain #37.

Rollback restores public files only. The newer private SQLite ledger, frozen edition and source evidence remain intact. Full private-environment recovery remains part of #36; this checkpoint does not claim that rehearsal is complete.

## Activation and stopping boundary

Both existing activation flags remain required and unset by this change. The maintained manual Friday commands in [the stage contracts](weekly-stage-contracts.md#maintained-manual-commands) and the main deployment workflow are unchanged. Controlled publication must not be enabled until the manual publisher joins destination ownership and the preview/recovery rehearsals pass.

The operator selected: implement and test Verify Release, push a stacked PR, then stop. This does not authorize merging or deploying the combined release PR #61. Automatic acknowledgement, the full Friday orchestrator and observed-Friday acceptance remain later work.

## Verification

Use Node 24.19+ and the locked dependencies. Run the ingestion build before testing; do not rebuild its `dist` directory while fingerprinted worker tests run.

```text
npm run build:etl
npm run typecheck:publication
npm run test:ingestion -- src/test/ingestion/release-live-inventory.test.ts src/test/ingestion/pages-workflow.test.ts
npm run test:ingestion -- src/test/ingestion/pages-candidate-runner.test.ts
```

The browser tests use isolated Chromium contexts and mocked public site responses, with real IndexedDB. Set `ZIVV_RELEASE_BROWSER_TESTS=1` to include the browser cases. The optional `ZIVV_RELEASE_SITE_FIXTURE` selects a local built site for an additional real-application rehearsal; it never selects a production deployment target. Use the existing installed Chromium path via `PLAYWRIGHT_BROWSERS_PATH` where necessary.

GPT-6.1 Sol high implemented and tested the browser lane and independently audited the stage. The parent implemented the HTTP inventory, controller and workflow integration. Exact final results are recorded in the PR and issue comments.

Final checkpoint evidence: 132 focused tests passed across the live inventory (7), workflow (7), dispatch (39), controller (60), browser (15), and selected native publisher integration cases (4). The other 17 native publisher cases were excluded by the focused test-name filter; the preceding checkpoint records their baseline validation. The four selected native cases completed in 246.18 seconds with exit code 0. A prior run passed their assertions but encountered a Vitest progress-RPC timeout; yielding between fixture Git batches resolved it without suppressing errors or changing production deadlines. The controller's disposable Git fixture also required execution outside the restricted temporary-directory sandbox.

The browser suite included real Chromium against retained full and empty Zivv application builds, plus stale-cache regression fixtures. App/ingestion/publication-test TypeScript, repository lint, changed-file formatting, production Vite build, CLI activation guard and diff checks passed. These are local/isolated results; controlled Pages publication and the broader Friday system remain inactive.
