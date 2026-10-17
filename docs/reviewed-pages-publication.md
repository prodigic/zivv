# Reviewed GitHub Pages publication

This checkpoint connects the retained public candidate to a reviewed publisher
workflow. It is part of [the Friday delivery plan](friday-delivery-plan.md),
issues #35, #36 and #39. It does not activate unattended publication.

## Code and candidate identities

The publisher runs from `refs/tags/zivv-workflows/<workflow commit SHA>`, where
the tag resolves to that exact commit and the commit is an ancestor of reviewed
`main`. This workflow commit identifies the tooling. The candidate's source
commit identifies the reviewed application build. They need not be equal.

Dispatch passes the planned operation, attempt, current control head, retained
payload commit, candidate identity and source commit. The admitted job binds the
actual GitHub run ID and run attempt. A rerun is not implicitly a new authorized
attempt. The remote controller remains authoritative; a local receipt or a
historical successful admission does not authorize a new deployment.
New dispatch intents also retain a fresh nonce. Even equal timestamps cannot
make competing prepared Git commits identical and give both callers permission
to submit a workflow.

The workflow compiles ingestion tooling only. It materializes the exact retained
public bytes and uploads only their Pages archive. It does not rebuild the site
or load the private recovery key. The public artifact contains no raw source,
private SQLite database, operator journal or recovery capsule.

Rollback targets the controller's previous verified public release. A legacy
snapshot remains explicitly legacy: its retained commit and complete file
inventory authorize the bytes, without inventing a candidate ID or claiming a
matching encrypted ledger revision. Rollback never rewinds the private ledger.

## Uncertain effects

Before calling Pages creation, the admitted run appends a fresh creation intent
using compare-and-append against the exact controller head. Only the caller that
wins that new intent may issue its single POST. A fresh nonce distinguishes
competing callers. Resuming a saved requested state grants recovery permission,
not permission to create again.
Prepared native Git appends are flushed to distinct
`zivv-pages-operation.json.append-<commit>.json` files before the remote write.
Only a confirmed winner updates the shared job checkpoint, so a losing caller
cannot overwrite the winner's recovery metadata.

The returned deployment ID is saved immediately and attached to that exact
creation intent before status polling. When the response is lost, the controller
retains ownership. The Pages API provides no documented listing that binds an
unknown deployment to its artifact and run. A timeout, workflow failure, or a
commit-SHA status lookup cannot justify a blind replacement deployment.

A definitive creation rejection can be recorded and followed by a new numbered
intent. HTTP 408 and transport uncertainty are not definitive rejections. A
known deployment is polled by its exact ID. Unknown status and
`deployment_lost` retain ownership. Deployment success is not live verification
or acknowledgement of the weekly cutoff.

The optional creation record preserves the serialized shape of existing v1
states. Previously retained control commits remain readable and retain their
identities. The dispatch nonce is also optional when reading historical states.
New effect jobs use the creation-intent path even though old legal
state transitions remain readable for historical recovery.

## Credentials and activation

Actions receives the minimum publisher permissions: contents write, Pages write
and OIDC token write. Tokens are transient request credentials. Git receives an
explicit token through child-process environment headers, clears configured
headers/helpers for that authenticated call, disables redirects and never writes
the token to command arguments or repository configuration. Dependency install
and compilation do not receive publisher credentials.
The authenticated Git overrides use the exact repository URL and enforce TLS
verification, so more specific repository configuration cannot bypass them.
Durable receipts pass a strict field and destination validator before public
output; a checksum alone does not establish that checkpoint metadata is safe.

The existing manual workflow remains available. Both
`ZIVV_CONTROLLED_PUBLISHING=enabled` and `ZIVV_MANUAL_PUBLISHER_JOINED=true` must
be set before this workflow may execute effects. Those flags represent real
activation prerequisites, not evidence that they have passed. Before setting
them, make the manual path participate in the same remote ownership controller,
retain and live-verify rollback bytes, verify runtime permissions, and pass the
preview, recovery and failure rehearsals.

The [Verify Release checkpoint](verify-release.md) adds live inventory, routes,
cache checks and guarded public rollback. Later checkpoints complete
acknowledgement, portable recovery, optional metadata
queue, source acquisition, runtime and alerts. Two observed scheduled Fridays
remain acceptance requirements.

## Operator entry points

After activation prerequisites pass and an operation has been claimed in the
remote controller, use a fresh private directory for each dispatch attempt:

```text
npm run pages:dispatch -- --workflow-commit REVIEWED_SHA --mode promote --intent-dir PRIVATE_DIRECTORY
npm run pages:recover-dispatch -- --workflow-commit REVIEWED_SHA --mode promote --intent-dir PRIVATE_DIRECTORY
```

The process receives `GITHUB_TOKEN` and the two activation flags from the chosen
runtime. Keep credentials out of command arguments. `recover-dispatch` reads the
same saved intent; it cannot create another workflow. If `dispatch` encounters
an existing saved intent, it also performs recovery only. A different candidate
or planned attempt needs a separate directory and a legal controller transition.
Rollback uses `--mode rollback` after the controller has authorized it.

The workflow invokes `scripts/run-pages-candidate.js` in order: `admit`,
`materialize`, `request-deployment`, `status`, `receipt`, then `verify-release`.
These are job commands
bound to the actual GitHub dispatch envelope and admitted run, not local bypasses.
The final receipt explicitly reports `liveVerified: false` and
`cutoffAcknowledged: false`. The subsequent `verify-release` command produces
live verification evidence; acknowledgement remains a separate later stage.

## Verification evidence

GPT-6.1 Sol high handled the workflow, API, controller and dispatch lanes, with
independent integration audits. The parent completed the job integration after
the runner agent reached its usage limit. Findings corrected URL-specific Git
credential overrides, optional checkpoint serialization, extra receipt metadata
escaping validation, API deadlines consumed by durable Git writes, and a losing
writer overwriting the winning job checkpoint.

All 66 ingestion/component test files were covered: 884 tests passed and one
existing POSIX-permission test was skipped on Windows. The broad gate excluded
the slow publisher file; three existing raw-Git cases exceeded their default
five-second budgets under load. With scoped 30-second budgets, that entire
42-test file passed. The final publisher file passed all 18 cases in 754.92
seconds, including real competing callers, interruption/replay, strict private
checkpoint parsing, legacy rollback and a POSIX tar round trip.

Application and ingestion TypeScript, the tracked publication-test type check,
repository lint, changed-file formatting, production Vite build and diff checks
passed. Compiled CLI guards rejected missing activation/credentials before
effects. Tests used disposable stores and remotes; no source import, production
control bootstrap, catalog change, weekly cutoff change or Pages API deployment
was performed by these tests. These results are local evidence, not a claim that
the new workflow has executed on GitHub or that Friday activation is complete.

See [the primary-source API findings](research/pages-deployment-recovery.md)
and [durable promotion control](durable-promotion-control.md).
