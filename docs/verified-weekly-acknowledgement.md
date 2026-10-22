# Verified weekly acknowledgement

Implementation checkpoint for [#31](https://github.com/prodigic/zivv/issues/31),
following [Verify Release](verify-release.md). This adds the acknowledgement
executor; it does not activate a scheduler, invoke it against the operator's live
store, or yet connect the complete delivery CLI.

## Ordering and authority

`acknowledgeVerifiedWeeklyRelease` requires a persisted weekly run through Verify,
its exact sealed candidate identity, the production journal lease, a native
promotion-control store and the worker's context guard. The remote state must
contain the exact verified candidate/source, inventory and deployment; a receipt
JSON supplied by a caller is insufficient. The native store validates immutable
Git history and expected-head appends.

The current weekly file must match the sealed candidate's configuration bytes.
This binds the full frozen state, including membership, cutoff and edition
metadata. A correction to an already published edition may acknowledge another
verified candidate without advancing the cutoff or changing frozen membership.

```text
verified native owner + exact weekly bytes + journaled candidate
  -> prepare acknowledgement intent and terminal Git objects locally
  -> persist both exact append intents in the private journal
  -> append remote acknowledgement-intent (owner stays held)
  -> guarded weekly cutoff write and exact readback
  -> guarded terminal remote acknowledgement + completion proof
  -> journal acknowledgement receipt
```

The public controller stores only the private intent's SHA-256 identity and
verification receipt ID. Private before/after weekly bytes and prepared append
material stay in the operator journal. Intent replay is exact; another intent or
final acknowledgement ID is rejected. There is no expiry-based owner release.

The existing verified phase already prevents a new claim or rollback. The new
intent binds the ensuing local effect without changing that phase. Retained legacy
states and direct terminal events remain readable with their original hashes;
the new executor requires a bound intent. That compatibility is not permission
for new effect callers to bypass intent persistence.

## Recovery

- Before any remote write, exact expected/attempted control heads, bytes and dates
  for both appends are retained. Retry recreates and revalidates native objects,
  rather than reparenting a changed mutation.
- An uncertain intent append must be reconciled before the weekly file changes.
- Uncertainty retains the running acknowledgement attempt and its immutable
  intent. The delivery adapter must resume that attempt, not mark it failed and
  start a fresh one while its external effects remain unresolved.
- A crash before the cutoff write resumes the same intent. A crash after it
  recognizes the exact after bytes and never advances a second cutoff.
- Both cutoff writing and terminal acknowledgement hold the journal guard and
  ingestion lock. Lease expiry/context drift can leave a committed file effect;
  recovery inspects that file instead of assuming rollback.
- A lost terminal response is resolved with the native completion tree proof.
  A later verified release does not erase that historical proof.
- Unexpected weekly bytes, another owner, wrong candidate/inventory/deployment,
  missing private intent or conflicting completion fail closed. No import or
  deployment is retried by this executor.
- After proven remote completion, journal recovery accepts the same published
  target edition even if later editions have legitimately been added. It never
  rewrites the weekly file during that recovery.

## Boundaries and remaining work

This library executes real weekly-file and controller effects when deliberately
called. Tests use disposable stores and synthetic releases. No operator cutoff,
catalog, keys, publishing flags or production refs are changed during development.

The [weekly delivery journal adapter](weekly-delivery-journal.md) now adopts exact
native deployment and verification evidence under the worker's context and lease,
then calls this executor. Dispatching the publication itself remains separate.
The maintained manual publisher must participate in the same controller before
controlled publishing activates. Source acquisition, local scheduling, portable
private recovery, deduplicated notifications, failure rehearsals and two observed
Friday editions remain open in the [Friday plan](friday-delivery-plan.md).

The existing manual `weekly:mark-published` path is unchanged and does not gain
automatic verification authority from this implementation. Public acknowledgement
must not trigger an uncontrolled second candidate/deployment; publication adapter
wiring and repository state handling remain separate acceptance work.
