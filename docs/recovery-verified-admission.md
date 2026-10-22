# Verified release acknowledgement recovery

This optional recovery scope admits an original retired run with its first ten
weekly stages succeeded, acknowledgement pending and no acknowledgement artifact.
It authenticates the captured candidate and the exact original deployment and
verification in native canonical history. Native acceptance evidence is pending;
implementation alone does not authorize operational activation.

```sh
npm run operator:recovery -- resume-verified --file CAPSULE --receipt RETIREMENT_RECEIPT --key PRIVATE_KEY_FILE --destination PREPARED_ROOT --npm-cli EXACT_REPLACEMENT_NPM/bin/npm-cli.js --repository AUTHORITATIVE_GIT --run-id ORIGINAL_RUN --workflow-commit ORIGINAL_REVIEWED_WORKFLOW_SHA
```

Require `ZIVV_CONTROLLED_PUBLISHING=enabled` and
`ZIVV_MANUAL_PUBLISHER_JOINED=true`, verified old-installation retirement and the
prepared retained runtime. Source and workflow remain on fresh authoritative
main. `GITHUB_TOKEN` optionally supplies Git credentials; existing Git credentials
may be used. This scope makes no GitHub HTTP requests.

## Bound authority

The signed `recovery-verified.json` admission binds the original capsule, physical
runtime, original run, reviewed workflow, candidate and canonical verification.
The predecessor acknowledgement is selected before the original claim, so an
accepted acknowledgement from this recovery cannot replace its own baseline.
Original first-ten stage rows and artifacts, frozen membership, catalog revision,
IDs, first-added dates and retained claim/dispatch files stay unchanged.

The normal weekly runner may create the first acknowledgement intent for this
verified owner, accept that exact intent, write its deterministic published weekly
file and complete that same acknowledgement. An accepted intent cannot be
replaced. Only the exact frozen weekly preimage or its authenticated deterministic
published result is allowed. The guard rechecks local evidence, runtime and
canonical authority immediately before each native Git append.

Recovery may finalize local evidence after its own proven completion, including
when a later canonical owner exists. It cannot append after that completion.
Before completion, another owner, rollback, failure, ambiguous history, altered
deployment/verification or an unrelated acknowledgement refuses recovery.
The quarantine remains active. This command grants no new build, dispatch,
verification, source acquisition or general scheduling authority.

On success, `recovery-verified-result.json` contains a signed report with status
`acknowledgement-complete`, `activationAllowed: false`, the original `runId`,
`candidateId`, `operationId`, `acknowledgementId`, unchanged `ledgerRevision` and
`admissionSha256`. Repeating the command must reuse the original signed admission
and acknowledgement without repeating publication or advancing the cutoff again.

## Acceptance and remaining gates

Require genuine native capture, retirement, deleted-original-roots recovery and
same-identity retry, plus interruption recovery after intent save, intent binding,
cutoff write and remote completion. Refusal tests must cover altered anchors,
forged acknowledgements and unrelated owners. Controlled provider fixtures are
not a live GitHub deployment or a representative full production rehearsal.

Fresh-chain recapture/composition, started-build recovery, operational durability,
credentials, scheduling, notifications and two observed Friday editions remain
open under #78 and #38. See the [Friday delivery plan](friday-delivery-plan.md).
