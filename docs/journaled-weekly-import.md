# Journaled weekly import

Implementation checkpoint for #31, stacked on the [guarded import](reviewed-weekly-import.md).
The [Friday plan](friday-delivery-plan.md) and [stage contracts](weekly-stage-contracts.md)
remain the full acceptance contract.

`runWeeklyImport()` now executes the real acquisition, preparation, reconciliation
and loading stages. Acquisition accepts an operator-supplied raw source; the
automatic source adapter remains #30. Every run retains the original delivery,
edition, exact raw hash and import observation. Its rules identity binds the
compiled worker/ETL inventory, dependency lockfile, import configuration and
Node/ICU runtime. The inventory covers `dist/lib`, `dist/types` and `dist/utils`;
frontend/data rebuilds do not change it.

## Run and resume

Set `ZIVV_LEDGER_HOME` to the existing private shared installation, then check
`npm run ledger:status`. A new run requires an explicit original observation with
a valid timezone-qualified ISO instant:

```sh
npm run weekly:run-import -- --file <private-source> --edition-id <YYYY-MM-DD> \
  --delivery-id <source-delivery-id> --observed-at <original-ISO-instant> \
  --through reconcile
npm run weekly:run-import -- --run-id <persisted-run-id> --through load
```

`--through` supports `acquire`, `prepare`, `reconcile`, `load` and the subsequent
[freeze checkpoint](journaled-edition-freeze.md), followed by `enrich`, `export`
and `validate` in the [candidate checkpoint](journaled-candidate-stages.md).
Explicit `verify` and `acknowledge` resumes are available through the gated
[delivery journal adapter](weekly-delivery-journal.md);
default `load`
commits a clean guarded import. Stopping after reconciliation leaves the catalog
unchanged. Resume needs the run ID; the source file can be removed because raw
bytes were retained atomically with run creation. Output shows stage/phase, IDs,
hashes and status, without raw source or private report contents.

With the default, these commands finish the four import stages and leave the seven
delivery stages pending. The existing manual weekly preparation, ETL and
publication commands remain usable. The default does not freeze an edition,
advance the published cutoff or activate a schedule.

## Durable evidence and interruption handling

Journal schema 2 adds immutable `stage_artifact` rows keyed by run, stage and
attempt. Existing genuine schema-1 journals migrate transactionally while keeping
run history and ownership. Unexpected tables, markers and dangling references
fail closed. Raw intent is stored in attempt zero at run creation; later attempt
artifacts retain their exact bytes/hash. Each artifact is limited to 64 MiB.

Preparation keeps its validated catalog snapshot, full preflight accounting and
prepared bytes. Verification recomputes that decision against the captured
catalog, preserving it across later artist renames. Reconciliation stores the
clean receipt/report and a fresh preflight catalog context. A blocked review can
retry after a canonical repair if raw/rules/accounting still agree; successful
history is never rewritten. Private normalization/reconciliation diagnostics stay
in the failed attempt artifact and are omitted from ordinary error logging.

Loading stores a validated post-load catalog snapshot and linked evidence. Its
logical digest, committed run, original observation and all report ID lists must
agree with the recovered durable receipt. This proves the recorded revision
without requiring today's catalog to remain unchanged.

Pending/failed stages start a new counted attempt. A running stage is inspected:
saved source/preparation/review artifacts are checked, while loading inspects the
actual committed catalog run and saved report. A running load with no committed
run becomes failed with `NO_COMMITTED_IMPORT`; another invocation explicitly
starts its guarded retry. A committed run with missing or changed reports blocks
recovery. Reports without a committed run do not prove an import happened.

The destination lease is renewed at guarded checkpoints. The journal holds its
SQLite writer transaction through catalog operations, preventing another process
from taking ownership while a catalog commit finishes. Catalog callbacks check
the pinned physical store, worker/rules context and ownership before/after writes.
Lease expiry does not authorize blind repetition of an external effect.

Fresh additions with an observation earlier than an existing draft/published
cutoff are quarantined with `LATE_IMPORT_REQUIRES_REVIEW`. Weekly state is checked
again within the guarded write. Already committed recovery remains allowed after
freezing. This preserves first-added dates and avoids silently losing an addition
from both the old frozen window and the next weekly window.

Changing raw bytes under the same delivery, changing original observation, or
changing the worker/rules context cannot silently create a replacement run. Code
and configuration successor generations still need explicit integration before
activation; retain the original runtime/context for an interrupted run meanwhile.

## Evidence, 2026-10-14

Sol high tests include a real child process killed after catalog commit but before
journal completion. Resume found the durable run and completed the same attempt
without a second import. Actual CLI checks cover source deletion before resume,
canonical renames/repairs, physical-store drift, forged receipt/load evidence,
missing reports and draft/published cutoff protection.

The full ingestion/component gate passed 539 tests with one skip across 51 files.
An earlier run passed its cases but exited with a worker-reporting RPC timeout;
bounding Vitest to four workers produced a clean exit without suppressing errors.
Application/ETL and explicit test-file strict TypeScript, lint and formatting
passed. The final progress-message change also passed the actual CLI resume test.

A disposable copy of the full 4,641-event catalog accepted one synthetic show,
then resumed by run ID with no additional catalog change. Every existing event ID,
slug and first-added date remained intact. All four import stages completed, the
seven delivery stages stayed pending, and weekly state was unchanged. The trial
took 17.837 seconds including fixture setup and resume. Authoritative production
digest remained `5d2360394cf1242b9cc98e2124a850885cf4df0e49e75eb9249783812e38d0c4`.
The controlling worker was work in progress during the rehearsal; no production
import, publication, acknowledgement or schedule was performed.

## Remaining delivery integration

- Explicit successor generations for code/configuration changes and new review
  after a successful review becomes stale; preserve original source observation
  and settle all pre-cutoff batches before freezing.
- Freeze/enrichment/export/validation stages linked to the reviewed candidate
  build and trusted candidate identity. Preserve membership through corrections
  and carry later additions into the next edition.
- Exact-byte preview/promotion, live verification, acknowledgement and public
  rollback; full encrypted recovery must include journal/artifacts alongside the
  catalog and weekly/configuration state (#35–#36/#39).
- Source adapter, runtime/credentials, independent monitoring and alerts, final
  failure drills and two observed scheduled Fridays (#29–#30/#37–#38).

The authoritative catalog and journal remain private, local operator storage.
The existing catalog-only encrypted snapshot does not yet recover journal
evidence. Full private recovery remains an activation prerequisite.
