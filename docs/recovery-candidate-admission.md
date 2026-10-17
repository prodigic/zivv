# Resume a validated candidate through dispatch

This optional recovery scope resumes one original run whose acquire through
validate stages all succeeded before retirement. It consumes the existing sealed
release bundle and schema-2 build/tool evidence. Its local authority ends at
dispatch; it does not enable general intake, another build, local release
verification, acknowledgement or scheduling.

## Prerequisites and command

Complete [planned retirement](operator-retirement.md) and
[runtime preparation](recovery-runtime-preparation.md). Drain the former host;
fresh remote observations do not fence an undrained installation. Keep the final
capsule, retirement receipt and separately stored recovery key in private operator
storage. The prepared destination must match its original physical preparation
binding, including the exact provisioned Node/ICU/worker/npm closure.

Run from a separately provisioned reviewed controller checkout with the matching
compiled runtime. The command launches the retained worker inside the prepared
destination. The restored checkout is a quarantined runtime, not a development
installation with compiler dependencies.

```text
npm run operator:recovery -- resume-candidate --file PRIVATE_FINAL_CAPSULE --receipt PRIVATE_FINAL_CAPSULE.retirement.json --key PRIVATE_BASE64_RECOVERY_KEY --destination PREPARED_PRIVATE_ROOT --npm-cli REPLACEMENT_NPM_PACKAGE/bin/npm-cli.js --repository AUTHORITATIVE_GIT_CHECKOUT --run-id ORIGINAL_RUN_ID --workflow-commit REVIEWED_PUBLISHER_SHA
```

As with the normal controlled publisher, production requires
`ZIVV_CONTROLLED_PUBLISHING=enabled`, `ZIVV_MANUAL_PUBLISHER_JOINED=true` and a
privately provisioned `GITHUB_TOKEN` with the required Git/workflow permissions.
`--key` names the private base64 key file. Tokens and keys are not command-line
values or signed admission fields; transient child inputs use bounded stdin.
The CLI exposes no fixture repository, HTTP endpoint or crash-injection flags.

## What admission proves

The capsule's post-load ledger is newer than its last acknowledged public
baseline. Admission therefore verifies the original reviewed preimage against
the latest canonical acknowledgement, then reconstructs the exact recorded import
and checks its load, frozen weekly membership and sealed candidate lineage. It
rejects intervening unproved catalog edits/imports, missing artifacts and changed
rules. It never accepts unequal ledger digests solely because one looks newer.
For newly introduced artists/venues, the current parser records wall-clock
creation/update times. The gate preserves only those authenticated timestamp
fields within observation, commit and capture bounds, then compares the entire
reconstructed ledger exactly. Existing entity timestamps and all event/source
observations remain exact.

Candidate source and reviewed workflow must belong to fresh authoritative main;
the publisher workflow blob must exist. A restored candidate directory is resolved
only from its captured export role and retained inventory. Original receipt bytes,
paths, npm identity, source observations, completed stage records and candidate ID
remain unchanged. Git objects/refs are handled in the separately bound
authoritative checkout; restored configuration and bundles stay in the private
prepared tree.

The private signed `recovery-candidate.json` binds that evidence, exact physical
paths, workflow and initial canonical control head. On retry the gate proves
canonical progress from that same head for the exact original run/candidate and
workflow. A competing owner, changed main/artifact, rollback, failure,
acknowledgement or unrelated transition refuses continuation. It can recognize
its own workflow reaching verification quickly while keeping local verify/ack
stages pending.

Existing native claim-plan recovery and workflow GET reconciliation preserve the
original operation and dispatch attempt. Lost responses never authorize another
dispatch POST. A pending result requires investigation/reconciliation rather than
blindly replacing the attempt. The normal publisher's Friday time gate still
applies.

Runtime/dependency/immutable evidence and fresh canonical authority are checked at
publication effect boundaries, followed by another journal lease check. Only the
selected run's publication plan/dispatch records, admission/result records,
working key, permitted encrypted-backup output and SQLite operational files may
change. Retained candidate, source, build and report evidence stay immutable;
catalog revision must remain the captured revision. Quarantine remains in place.

## Retry and remaining work

Retry the same command with the same inputs. Exclusive crash-recoverable intent
and key installation use the existing recovery key. Keep partial private evidence
for investigation. Success/pending observations are signed privately in
`recovery-candidate-result.json`, with the original run/candidate/operation and
admission digest; `activationAllowed` remains `false`.

An original succeeded validation stage must carry durable validation evidence.
Missing historical evidence is refused, not silently fabricated or waived.

This implements the validated-bundle path of
[#78](https://github.com/prodigic/zivv/issues/78). Frozen checkpoints that still
need a build, recovery from separately captured pending dispatch or
verified-before-acknowledgement, off-machine durability, unattended
credentials/scheduling/notifications and observed Friday runs remain separate
acceptance work. See [the Friday plan](friday-delivery-plan.md).
