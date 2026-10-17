# Resume a retained import through load

This optional recovery command resumes one authenticated Friday run after its
original installation has been retired. It implements the before-load recovery
case in [#78](https://github.com/prodigic/zivv/issues/78). It does not activate a
replacement installation or enable publication, intake or scheduling.

## Prerequisites and command

Complete [planned retirement](operator-retirement.md), including draining the
old installation, and [runtime preparation](recovery-runtime-preparation.md).
Retain the final encrypted capsule, its retirement receipt, the original recovery
key and the exact provisioned Node/npm profile. The selected original run must
have successful acquire, prepare and reconcile stages, with load and every later
stage pending in the captured journal.

```text
npm run operator:recovery -- resume-import --file PRIVATE_FINAL_CAPSULE --receipt PRIVATE_FINAL_CAPSULE.retirement.json --key PRIVATE_BASE64_RECOVERY_KEY --destination PREPARED_PRIVATE_ROOT --npm-cli REPLACEMENT_NPM_PACKAGE/bin/npm-cli.js --repository AUTHORITATIVE_CHECKOUT --run-id ORIGINAL_RUN_ID
```

`--key` names the private base64 key file, not literal key bytes. The destination
and physical npm path must match preparation. `--repository` supplies the local
checkout used for authoritative Git observations; the production transport uses
the fixed HTTPS repository endpoint. Local fixture transports are unavailable
through the CLI. The command requires authenticated read access if the remote
repository needs it.

## Admission and execution

Admission authenticates the capsule, retirement receipt, prepared runtime and
original journal. It reads fresh canonical main/control/artifact refs and verifies
the latest acknowledged publication, its completion proof, retained payload and
encrypted ledger. That acknowledged ledger must exactly match the captured
before-load ledger, and the selected source observation must not precede its
acknowledged cutoff. The acknowledged source commit must be an ancestor of fresh
main. An active publication owner, moved refs, divergent ledger, obsolete source,
legacy-only control history or missing native acknowledgement causes refusal.
These reads establish freshness; they do not fence an undrained old host.

A private HMAC-signed `recovery-import.json` binds the original run, source,
retirement evidence, physical paths, remote state and immutable prepared tree.
The command installs the existing recovery key and runs the actual retained
compiled worker under its verified module boundary. Keys and capsule bytes pass
to the child through bounded stdin, never command-line arguments. Child output
and execution time are bounded; raw private diagnostics are not printed.

The worker receives an in-process authority limited to that run through `load`.
It cannot start another run, capture fresh mail, freeze a candidate, build,
dispatch, verify or acknowledge publication. The quarantine marker remains in
place and ordinary worker invocations remain blocked. The original rules hash
and successful prerequisite stage records remain exact. Remote/runtime checks
repeat before load effects, and the journal lease is checked again after remote
reads.

Only the selected journal/catalog databases, their SQLite auxiliary files,
working-key files, admission/result records and allowed new report/backup files
may change. Retained reports and backups stay immutable. Inventory checks still
validate paths, types, hardlinks, sizes and bounds for mutable database files,
but avoid reading active WAL/SHM content while SQLite holds it.

## Retry and evidence

Intent and key publication use complete flushed private temporary files followed
by an exclusive link. A retry authenticates existing bytes and cleans only its
own matching publication links; conflicting keys, intent bytes and arbitrary
hardlinks are refused. Private installation scratch lives beside the prepared
root, outside its authenticated tree. Preserve this scratch with failed evidence
until investigated; it can contain private key material.

Retry the same command with the same inputs after an interrupted admitted load.
The retained worker reconciles a committed effect with its original run journal
without duplicating the import. Retrying does not select a new run, replace a key
or reset the prepared tree. An interruption after durable intent but before key
installation also resumes with the original key. Changed retained evidence or
dependencies require investigation rather than bypassing validation.
An interrupted result write can leave its bounded atomic-write temporary file;
the same-run retry preserves it and regenerates the signed result.

Success writes a private HMAC-signed `recovery-import-result.json` and reports
`status=load-complete`, the original run ID, ledger revision and admission hash.
`activationAllowed` remains `false`. The pristine prepared-tree verifier is no
longer the verifier for a destination whose databases have legitimately changed;
the admission record and bounded retry checks cover that state.

This is one recovery scope. Post-load/build, dispatched-publication and
verified-before-acknowledgement recovery, off-machine durability, unattended
credentials, scheduling/notifications and observed Friday runs remain separate
acceptance work in [#36](https://github.com/prodigic/zivv/issues/36).
