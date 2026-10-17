# Publication from the weekly worker

Checkpoint for [#31](https://github.com/prodigic/zivv/issues/31) and
[#35](https://github.com/prodigic/zivv/issues/35), following the
[verified delivery adapter](weekly-delivery-journal.md).

The worker can now retain its validated public candidate, claim the native
production controller and invoke the reviewed publisher. Its next invocation
reconciles the same request. Once native verification succeeds, that invocation
can journal delivery and acknowledge the weekly cutoff. This is implementation,
not production activation.

Early source preparation remains allowed. Publication itself requires a Friday
edition and waits until that Friday's midnight in America/Los_Angeles, including
daylight saving changes. Resuming an accepted earlier edition after Sunday is
recovery; acceptance of new late source deliveries remains the intake policy.

```text
same private run + sealed release candidate
  -> authenticate saved bundle against original validation
  -> save immutable payload/claim plan privately
  -> retain exact public artifact; confirm remote identity
  -> append exact prepared production claim
  -> existing durable workflow dispatch/recovery
  -> return pending while workflow runs
  -> resume same run; adopt native verification; acknowledge
```

## Commands and completion

Use the current private shared installation and maintained runtime. After a
release-purpose candidate is validated, the following command opts into native
publication, provided all activation prerequisites have separately passed:

```sh
npm run weekly:run-import -- --run-id <persisted-run-id> --through acknowledge --candidate <private-candidate-json> --workflow-commit <reviewed-main-SHA>
```

The workflow commit identifies reviewed publishing tools and must be present on
the locally verified authoritative `origin/main`. It may differ from the
candidate's reviewed application source. It uses the existing immutable
workflow-tag protocol. `GITHUB_TOKEN`, `ZIVV_CONTROLLED_PUBLISHING=enabled` and
`ZIVV_MANUAL_PUBLISHER_JOINED=true` remain required. This change sets no flags and
does not invent a production bootstrap.

Repeat the same command to continue. Exit code zero means a checkpoint was saved;
the public-safe JSON `deliveryStatus` distinguishes `pending`, `verified` and
`acknowledged`. Only succeeded acknowledgement proves this run completed
publication and cutoff recording. `--through dispatch` explicitly stops after
requesting/reconciling the workflow and leaves deployment running. `--through
verify` can initiate/reconcile publication and stop after verified delivery.
Omitting `--workflow-commit` on verify/acknowledge retains the adoption-only path,
which expects native verification to exist already.

The caller must schedule another bounded invocation while pending. This change
installs no polling loop, scheduler, missing-start monitor or email sender.
Ambiguous effects need reconciliation, not a fresh run ID or directory.

## Durable identities and recovery

The candidate directory comes from the private journal's saved export intent,
not an arbitrary caller directory. The payload builder reauthenticates sealed
public files, encrypted snapshot, original source and release-purpose build with
the existing private key. The supplied candidate must match saved validation and
export evidence. The public payload excludes cleartext source, private reports,
journal, database and key.

`weekly-publication/<run-id>/claim-plan.json` lives under the private operator
directory. Its canonical, immutable bytes retain run/candidate/workflow, payload
receipt and commit, creation time and exact prepared claim bytes, expected head
and attempted head. It is written before artifact retention or native claim. A
retry recreates and checks those identities against the original canonical
parent; it never substitutes today's previous release or reparents a failed claim.

Artifact retention uses its immutable non-served ref and exact remote readback.
Only then may the claim append. An advanced control tip is accepted only if the
prepared claim is a canonical ancestor and the current operation still matches.
The existing dispatch runner persists its own intent before controller dispatch
authorization and the single workflow POST. A saved intent invokes recovery,
including after a lost response. A missing match, conflict or uncertain effect
grants no permission for a replacement POST. An interruption before any dispatch intent exists
may resume the same planned operation without changing its claim.

The worker holds its private journal ownership guard during publication effects
and renews it while awaiting HTTP work. Deployment's journal artifact remains
reserved for the later native verification anchor. The claim plan and dispatch
files must join the private recovery capsule before activation; the catalog-only
encrypted backup does not include them.

When journal verification has succeeded, resume bypasses publication dispatch.
The retained delivery anchor and acknowledgement completion proof can therefore
finish after native acknowledgement cleared the active operation, even after a
later legitimate owner appeared.

## Activation and preserved fallback

Existing manual import/export/publication remains available with flags disabled.
The default worker still stops at load. No live source, catalog, cutoff, native
production ref, flags or schedule is changed by the tests or implementation.

Before enabling controlled publication, make the legacy push publisher participate
in or defer to the same ownership protocol using the
[mode transition runbook](publisher-mode-transition.md), retain/live-verify bootstrap and
rollback artifacts, and pass preview, recovery and failure rehearsals. Source
acquisition, scheduling, actionable notifications, private recovery, repository
state coordination and two observed Fridays remain open in the
[Friday plan](friday-delivery-plan.md). Keep using the documented
[manual path](journaled-weekly-import.md#run-and-resume) until these gates pass.

## Verification evidence

Sol high integration fixtures exercise real SQLite importing/freezing, candidate
sealing and authenticated payload creation, immutable Git artifact retention to a
disposable bare remote, and native claim/dispatch transitions. Only the existing
expensive application-build boundaries and GitHub HTTP responses are replaced.
The successful lifecycle simulates native workflow verification before the worker
acknowledges; it is not a live GitHub deployment rehearsal.

Four publication cases passed: complete pending/verify/acknowledge/replay,
interruption after the private plan, lost workflow response with no-match recovery,
and altered-plan/competing-owner rejection. They assert a single workflow POST,
unchanged import identity and catalog, exact retained plans and no repeated build.
Ten publication-time cases cover Pacific midnight on both sides of daylight saving
changes, invalid dates and invalid clocks. The maintained importer, CLI and timing
batch passed 39 cases. CI must independently run the entire exact-head suite.
