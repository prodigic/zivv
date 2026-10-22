# Retire a cooperating operator installation

This optional operation creates a final encrypted checkpoint and disables normal
writes from its source installation. It is a prerequisite for planned recovery
in [#78](https://github.com/prodigic/zivv/issues/78), not activation of a replacement
installation. It has only been exercised with disposable fixtures at this stage.

Keep the existing manual Friday path on the current installation until cutover
has been reviewed and rehearsed. Installing this code creates no retirement
marker and changes no source, catalog, cutoff, scheduler or production control.

## Command and retained evidence

Stop the source scheduler and drain known workers/children before planned
retirement. Ensure all cooperating workspaces use the guarded writer code. After
the relevant cutover gates are approved, the operation is:

```text
npm run operator:recovery -- retire --root CHECKOUT --out PRIVATE_FINAL_CAPSULE
```

The output must be outside Git and outside the operator directory. The existing
working backup key must be present; retirement never generates a replacement.
Successful retirement leaves three private files:

```text
PRIVATE_FINAL_CAPSULE                   encrypted final checkpoint
PRIVATE_FINAL_CAPSULE.retirement.json   portable signed receipt
OPERATOR_HOME/operator-retired.json    same signed receipt, local write fence
```

The receipt contains the original private operator path, a retirement installation
identifier, time, ledger revision, checkpoint digest and exact encrypted-archive
digest. It is authenticated with HMAC-SHA-256 using the existing backup key.
Keep the receipt private too; retain the recovery key separately.

The implementation takes production journal ownership, then its operation guard,
then a fresh catalog writer transaction. An outer catalog transaction is refused:
retirement cannot certify another callback's uncommitted changes. Under both
locks it captures and validates the exact state, exclusively creates/flushes the
encrypted archive, rechecks its bytes, and durably writes the retirement marker.
The marker is excluded from the checkpoint; a restored installation remains
quarantined by its existing `recovery-state.json`.

The retirement coordinator has narrowly scoped cleanup authority for its own
exact marker bytes, allowing its final transaction commit and lease release.
It cannot excuse a different concurrent retirement marker. Normal sibling work
and escaped asynchronous descendants after cleanup receive no such authority.
This is an internal trusted-code scope, not a user-selectable bypass flag.

## Failure and retry behavior

| Boundary                                          | Result and recovery                                                                                                                                               |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Active source owner or unsafe/occupied output     | Refuse before retirement; existing importing remains available.                                                                                                   |
| Archive written but marker not written            | A valid backup exists, but no retirement proof. Do not treat that backup as a retired source. Preserve it and investigate; a new capture needs a new output path. |
| Marker written but response/portable receipt lost | Source writers stay blocked. Retry the same command with the same archive to authenticate existing evidence and create only the missing portable receipt.         |
| Existing archive or receipt differs               | Refuse; never overwrite conflicting evidence, re-capture, or clear retirement.                                                                                    |

Archive and portable receipt creation are exclusive, including when another
operation races to create the same output. The receipt retry does not acquire a
new source lease or alter journal ownership. On Windows, the implementation uses
the existing flushed-file/atomic-marker protocol; it does not claim a distributed
transaction or independently tested power-loss guarantee across files and SQLite.

Verify portable evidence without the old machine:

```text
npm run operator:recovery -- verify-retirement --file PRIVATE_FINAL_CAPSULE --receipt PRIVATE_FINAL_CAPSULE.retirement.json --key PRIVATE_BASE64_RECOVERY_KEY
```

Verification authenticates both artifacts and their exact binding. It works after
the original roots have been deleted and always reports `activationAllowed=false`.

## What the local fence covers

Any retirement marker blocks cooperating catalog transactions/writes, journal
construction/mutations/ownership checks, ordinary worker/intake/capture entry,
weekly publication, workflow dispatch, retained-artifact pushes and native
promotion appends. Checks repeat after obtaining writer locks, before committing,
and before publisher effects. Read-only catalog/evidence inspection remains
possible. A marker appearing inside a transaction causes rollback.

This does not disable older unguarded binaries, cloned credentials, arbitrary
raw SQL/Git commands or administrators who remove the marker. It cannot cancel an
already accepted HTTP request, child process or GitHub workflow. A child may leave
late private build files in retired storage; it cannot advance the guarded
journal/cutoff or start another guarded publication. Existing interrupted-export
rebuild rules and canonical claim/dispatch reconciliation remain mandatory.

Do not delete the marker to resume source work. An unavailable old host without
a valid retirement receipt still needs separately reviewed shutdown/revocation
evidence. Replacement admission must independently verify exact runtime/tools,
working key, authoritative Git ancestry, remote ownership and private-state
durability, then pass the four fresh-environment resume drills. These remain
open in #78, #79, #36 and #38; signed evidence alone grants no execution authority.
