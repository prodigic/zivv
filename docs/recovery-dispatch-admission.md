# Reconcile a captured accepted dispatch

This optional recovery scope handles an authenticated capsule captured with the
first eight weekly stages succeeded, deployment running, and verification and
acknowledgement pending. It requires a unique original claim and accepted
dispatch intention in complete canonical history. It grants no new publication
attempt, remote append, local verification, acknowledgement or activation.

```text
retired pending-dispatch capsule + prepared retained runtime
  -> prove original import, freeze and validated candidate
  -> bind original accepted claim, attempt, nonce, timestamp and CAS bytes
  -> GET-only reconciliation of that same workflow run
  -> retain a matching receipt; leave verify/ACK pending and quarantine active
```

The explicit command is:

```sh
npm run operator:recovery -- resume-dispatch --file CAPSULE --receipt RETIREMENT_RECEIPT --key PRIVATE_KEY_FILE --destination PREPARED_ROOT --npm-cli EXACT_REPLACEMENT_NPM/bin/npm-cli.js --repository AUTHORITATIVE_GIT --run-id ORIGINAL_RUN --workflow-commit REVIEWED_WORKFLOW_SHA
```

The existing controlled-publishing and joined-publisher flags and private GitHub
token are required. Source and workflow must remain on fresh authoritative main.
Canonical claim, retained public artifact and the original dispatch intention
must agree with the captured candidate. Missing or ambiguous history, another
owner, rollback, failure, acknowledgement or a different attempt refuses recovery.

The original claim plan stays byte-for-byte unchanged. The retained dispatch file
may gain only a strictly validated receipt for its original intention and accepted
control head. Its nonce, inputs, pending CAS parent/child, bytes and timestamps
cannot change. An originally retained receipt is immutable. When private dispatch
metadata was not captured, canonical history may reconstruct the exact original
intention before the GET-only path runs.

Zero or ambiguous matching workflow runs remain pending. Neither result proves
that a POST was absent. Even an accepted intention captured before the original
POST cannot authorize another POST. Coordinator guards reject remote appends and
fresh dispatch, independently of the ordinary runner's saved-intention behavior.

## Limits and acceptance

This command does not admit checkpoints before an accepted dispatch intention.
Use the separately verified validated-candidate scope only for its supported
original checkpoint. A quarantined `resume-frozen` result cannot be composed with
this command merely by changing directory names or relaxing path checks; signed
prior-result composition and recapture require separate implementation and tests.

Implementation is not acceptance evidence. The PR must record real native
capture, retirement, deleted-original-roots recovery, lost-response and duplicate
retry results, including zero new POSTs or remote ref changes. Until those checks
pass this recovery class is unverified. Operational activation and observed Friday
releases remain tracked by the [Friday delivery plan](friday-delivery-plan.md).
