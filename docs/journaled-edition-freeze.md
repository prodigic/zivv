# Journaled edition freezing

Checkpoint for #31/#38, stacked on [journaled import](journaled-weekly-import.md).
The [Friday plan](friday-delivery-plan.md) remains the full acceptance contract.

The runner can now execute acquisition through edition freezing. Its default is
still `load`; existing manual weekly preparation and publication remain usable.
Freezing creates a draft and fixes membership. It does not publish, acknowledge
the cutoff, or activate a schedule.

## Run and recover

Use the existing private shared installation and check `npm run ledger:status`.
The cutoff must be an explicit timezone-qualified instant after the original
source observation and no later than the current time:

```sh
npm run weekly:run-import -- --run-id <persisted-run-id> --through freeze \
  --freeze-cutoff <ISO-instant>
```

A fresh source invocation supports the same freeze arguments. An interrupted
freeze resumes by run ID without repeating the cutoff: the private journal keeps
the immutable intent. Supplying a different cutoff fails instead of changing the
window. To process a later correction while reusing the existing edition:

```sh
npm run weekly:run-import -- --file <private-correction-source> \
  --edition-id <original-edition-id> --delivery-id <new-delivery-id> \
  --observed-at <original-correction-observation> --through freeze \
  --reuse-frozen true
```

Corrections retain the original edition, cutoff, event IDs and dataset version.
New additions observed after that cutoff remain eligible for the next edition.
The existing late-import guard still quarantines previously unseen additions
whose original observation precedes a frozen cutoff.

## Durable boundary

Before planning, the runner checks every registered run in the destination scope.
Any run observed before the cutoff whose load has not succeeded blocks freezing,
including failed or unresolved earlier deliveries. Automatic intake must register
all supported deliveries before this guarantee can cover unattended imports.
Explicit successor generations and unresolved-batch disposition remain required
before activation; this checkpoint does not silently discard blocked work.

Under journal ownership and the catalog writer lock, planning captures the current
catalog revision and the exact before/after weekly state. The journal durably saves
that intent before the weekly file changes. Before writing, ownership, runtime,
configuration, pending deliveries, catalog revision and weekly state are checked
again. Drift fails closed. The intent captures the catalog at freeze time, which
may legitimately include other completed deliveries after this run's own load.
Export evidence must bind to that freeze revision and its paired recovery snapshot.

After interruption, the runner verifies the saved intent. If the weekly write
already happened, it completes the same attempt without repeating it. Publication
may subsequently change status or advance the published cutoff; recovery accepts
that only while the target edition's frozen identity remains intact. Missing or
changed successful membership is an error. Membership hashes use the canonical
event-ID array, matching the existing release-candidate contract.

Legacy freeze evidence remains readable. New evidence additionally records
`mode` and `ledgerRevision`; correction mode relaxes only the initial observation
cutoff comparison, retaining edition identity and zero-pending requirements.

## Verification, 2026-10-14

GPT-6.1 Sol high produced twelve isolated SQLite/recovery cases, including two
actual CLI invocations. Coverage includes pending earlier deliveries, interruption
before/after the weekly write, changed cutoff/state, current catalog capture,
correction reuse, later additions in the next edition, and clock rollback before
the effect. A separate Sol high read-only audit found two issues: correction cutoff
validation and missing saved-intent temporal checks before the write. Both were
fixed and tested. No further material finding remained in that bounded review.

The full ingestion/component gate passed 553 tests with one skip across 52 files
and a clean exit in 97.55 seconds. Application/ETL builds, strict application and
explicit test-file TypeScript, lint, formatting and diff checks passed. The first
full run passed its assertions but failed a Vitest progress RPC acknowledgement:
the synchronous SQLite/filesystem fixture sequence exceeded its 60-second RPC
timeout. Yielding to the event loop after fixture cleanup resolved the reporting
failure on the full rerun; timeout/error handling remains enabled.

A disposable copy of the full 4,641-event catalog accepted one synthetic show,
completed five stages, and resumed without another import. Every existing ID,
slug and first-added date remained intact; the draft contained the one new event.
Six delivery stages stayed pending. The trial took 21.878 seconds including setup
and resume, and the authoritative production digest remained
`5d2360394cf1242b9cc98e2124a850885cf4df0e49e75eb9249783812e38d0c4`.
This was a work-in-progress worker rehearsal; production was not imported,
frozen, acknowledged, published or scheduled.

## Remaining work

At this freeze checkpoint, six later stages remain pending: enrichment, export,
validation, deployment, live verification and acknowledgement. The subsequent
[candidate checkpoint](journaled-candidate-stages.md) integrates the first three.
The remaining delivery must connect to captured reviewed builds,
exact candidate identity and recovery. Full encrypted recovery must also include
the private journal and artifacts. Source acquisition, runtime activation,
independent alerts, failure drills and two observed Fridays remain prerequisites
for claiming reliable unattended delivery.
