# Reviewed weekly import

Implementation checkpoint for #31 and #39 in the [Friday delivery plan](friday-delivery-plan.md).

The current manual importer can accept some rows while recording others for
review. `reviewSteveImport()` and `loadReviewedSteveImport()` provide the strict
path required by the Friday runner. Any unresolved reconciliation, core conflict,
unresolved normalization warning or dropped bill blocks the entire guarded load.
Existing manual commands retain their behavior.

Formatting heuristics for an exact name already present in the canonical artist
catalog are resolved by that known identity (for example `U2`). Unknown suspicious
names still require review; duplicate performer/bill warnings and dropped rows
always block.

## Review and load contract

Review takes prepared content and one explicit original import observation time.
It runs under the shared catalog writer lock and returns a clean report plus a
receipt binding exact input bytes, import configuration, input ledger revision,
report decision, importer/run identity and observation time. It writes no catalog
or import report; the lock may refresh the encrypted snapshot. Do not describe
review as making no filesystem writes.

Loading parses the receipt and checks the same inputs inside the SQLite writer
transaction. A changed ledger requires review again. Ownership is checked before
work, before writes and after the guarded save; ownership loss at the last check
rolls back the SQLite catalog transaction. Policy files are checked again after
the save and ownership check, immediately before the transaction returns;
configuration drift also rolls back the catalog.
An orphan report may remain if a transaction fails after the report was written.
Reports alone never prove that an import committed; inspect the durable catalog
run before recovery.

A committed replay may recover despite a newer ledger revision only when the
same run, original observation, clean saved report and reviewed decision agree.
It preserves IDs, first-added dates and source history. Missing, changed or linked
reports block recovery; do not manufacture a new run to bypass missing evidence.
Historical migration receipts cannot authorize a new Friday load.

The guarded APIs require shared SQLite. JSON cannot roll back an already renamed
catalog after a failed ownership check; it remains available through the legacy
manual importer. Receipt identities are integrity checks, not signatures: retain
the expected ID in trusted operator/journal state rather than trusting an ID read
from the artifact being checked.

## Operator commands

Set `ZIVV_LEDGER_HOME` to the permanent existing operator store and first verify
`npm run ledger:status`. These commands do not freeze an edition, publish, advance
the weekly cutoff or activate a scheduler.

```sh
npm run weekly:review-import -- --file <private-raw-text> \
  --output-dir <private-reviews-directory> --edition-id <YYYY-MM-DD> \
  --delivery-id <source-delivery-id> --observed-at <original-ISO-observation>
npm run weekly:load-reviewed -- --directory <review-directory> \
  --review-id <trusted-review-artifact-id>
```

The review command requires valid UTF-8, runs the deterministic full-row preflight,
checks the issue header against the nominated edition, and rejects a changed
preflight ledger/rules context. It retains exact raw bytes (including any BOM),
prepared text, preflight accounting, reconciliation report and import receipt in
private storage outside Git. `complete.json`, written last, identifies all five
files by hash/size. Retry never overwrites different evidence. For invalid source
diagnostics, use the [standalone preflight](steve-preflight.md), which retains the
raw source and invalid-row report.

Load requires the separately retained review artifact ID, verifies completion and
all files, and takes the `prodigic/zivv/production` destination lease before loading.
The future full runner must retain that scope through freeze, export, promotion
and acknowledgement; the command's lease currently covers only loading. Stale
evidence fails before accepted subsets can commit.

## Rehearsal evidence

On 2026-10-14 the real CLI ran against a disposable synthetic shared SQLite store:
three source rows became one accepted show, one exact duplicate and one programming
exclusion. Review left the catalog unchanged; load accepted one show; replay kept
the same ledger revision and original first-added time; changed prepared bytes
were refused. No production ledger, cutoff or publication was changed.

Sol high fixtures cover clean review/load/replay, stale source/rules/catalog/report,
missing and tampered receipts, whole-batch ambiguity, normalization loss, historical
replay refusal, and ownership loss before/after writes. SQLite rollback is tested
against the real isolated adapter, not a mocked transaction.

## Remaining integration

The full eleven-stage runner still needs trusted receipt persistence, interrupted
side-effect reconciliation and context generations for later corrections. Bind
raw delivery identity and original observation to the journal; settle every pending
pre-cutoff batch before freezing. Preserve frozen membership through corrections
and carry late additions into the next edition. Connect this guarded load to the
[reviewed candidate build](release-candidate.md), exact-byte publication/live
verification, acknowledgement and full encrypted recovery. Source acquisition,
runtime/credentials, monitoring and two observed Fridays remain activation gates.

The maintained manual import, weekly preparation, ETL and publication path remains
available at this checkpoint.

## Importer-version integration

Friday's whole-show cancellation and postponement parser uses
`steveslist-v6`. New review receipts and candidate run IDs share the current
importer constant. The receipt parser retains strict v4 and v5 support without
changing existing serialized identities: the importer name and run-ID prefix
must agree.

A historical v4 or v5 review can recover only its exact already
committed/published run, with the same corrected input, aliases, configuration,
observation and saved report evidence. It cannot authorize a fresh historical
version load under v6 parser semantics. Missing historical runs require new
review rather than silent reimport. Maintained manual commands use the current
v6 parser semantics; historical v4 and v5 receipt identities remain unchanged.

The ordered-merge ingestion gate exposed the original version mismatch.
Regression coverage includes current cancellation and postponement paths,
mixed-version rejection, refusal of uncommitted historical receipts and
unchanged v4/v5 committed replay history.
