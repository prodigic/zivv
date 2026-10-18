# Recover a frozen import through candidate validation

This optional command addresses the frozen-before-enrichment class in
[#78](https://github.com/prodigic/zivv/issues/78). It does not activate a restored
installation or publish a release. The earlier import and validated-candidate
commands remain separate admission scopes.

## Eligible checkpoint

Use a coherent version 2 retirement capsule and exact prepared runtime. The
selected production run must have acquire, preflight, reconcile, load and freeze
succeeded. Every subsequent stage must be pending, with no retained enrichment
or build context. The original source, first five stage records, loaded catalog,
frozen cutoff, membership and configuration remain authoritative.

The latest canonical acknowledged public artifact must reproduce the original
reviewed preimage. Replay the recorded import and prove the complete resulting
catalog and freeze, including the bounded original clocks of newly introduced
artists and venues. An unrelated intervening import, missing evidence or changed
canonical authority refuses admission.

## Command and new build choice

After preparing the runtime as documented in [runtime preparation](recovery-runtime-preparation.md):

```text
npm run operator:recovery -- resume-frozen --file CAPSULE --receipt RETIREMENT_RECEIPT --key PRIVATE_KEY_FILE --destination PREPARED_ROOT --npm-cli EXACT_REPLACEMENT_NPM/bin/npm-cli.js --repository AUTHORITATIVE_GIT --run-id ORIGINAL_RUN --source-commit REVIEWED_MAIN_SHA
```

The source SHA is an explicit new reviewed choice: no build source was selected
before this checkpoint. It must be an ancestor of freshly observed authoritative
main. Admission binds that SHA, exact authenticated replacement npm, staged
configuration, physical paths and idle canonical control before enrichment.
Retries must use the same inputs. The build purpose and base path are fixed to
`release` and `/zivv/`. Optional Git credentials are read from `GITHUB_TOKEN` and
passed privately; no publication token is required by the command itself.

Build outputs occupy a new run-specific namespace under the private operator
directory. The captured runtime, dependencies and all previously retained files
remain immutable. Source capture uses authoritative Git while enrichment and
export share the exact staged configuration. The module loader permits the new
ETL tree only inside the active admission after reviewed source and schema 2
build evidence have been verified.

## Completion and interrupted attempts

Success writes the signed private `recovery-frozen-result.json` with
`status: candidate-validated`, original run, unchanged catalog revision, candidate
ID, admission digest and `activationAllowed: false`. Deploy, verify and
acknowledgement remain pending. Canonical control and artifact refs must remain
unchanged.

A retained export intent with an interrupted build continues to fail with
`INTERRUPTED_CANDIDATE_BUILD`; this command does not replace hashed contexts or
discard evidence. Capsules captured after enrichment or during an existing build
need a separately verified relocation/recovery path. A runtime predating this
admission cannot be silently replaced inside an authenticated capsule.

Implementation is not acceptance evidence. Record the actual deleted-original-
roots build, replay, drift and interruption results on the implementation PR
before claiming this recovery class is verified. Operational durability,
credentials, scheduling, notifications and observed Friday runs remain in the
[Friday delivery plan](friday-delivery-plan.md).
