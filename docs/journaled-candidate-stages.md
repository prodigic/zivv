# Journaled candidate stages

Checkpoint for #31/#35/#39, stacked on [edition freezing](journaled-edition-freeze.md).
The [Friday plan](friday-delivery-plan.md) remains the full acceptance contract.

The worker now supports `enrich`, `export` and `validate` after freezing. The
default remains `load`. These stages capture reviewed metadata/configuration,
build an isolated candidate and validate its exact bytes. They do not deploy,
advance the published cutoff, activate a scheduler or perform new AI research.

## Operator command

Use the existing configured private shared store and check `npm run ledger:status`.
A first candidate stage requires all four build options. Preview code may be a
stack commit; release code must be an ancestor of the fetched `origin/main`.
Use the approved Node/npm runtime and nominate a complete commit SHA:

```sh
npm run weekly:run-import -- --run-id <persisted-run-id> --through validate \
  --freeze-cutoff <timezone-qualified-ISO-instant> \
  --source-commit <40-character-commit-SHA> --purpose preview \
  --base /zivv-test/ --npm-cli <absolute-approved-npm-cli-path>
```

If freezing already completed, omit its cutoff. Use `--reuse-frozen true` for a
new correction delivery as described in the freeze checkpoint. Stop at `enrich`
or `export` when needed. Completed enrichment stores its nominated build context;
subsequent resume may omit build options. Resupplying different options fails.
An interrupted enrichment whose context has not yet been checkpointed requires
the original options again; it cannot adopt an unbound artifact.

## Captured inputs and trusted output

Enrichment captures export configuration from the nominated Git commit, with the
verified frozen weekly bytes substituted. It retains exact bytes or explicit
absence for the fixed configuration inventory. New success evidence binds both
the configuration digest and the source commit, purpose, base path and installer
path through a build-context digest. Refreshing an altered artifact's checksum
does not authorize different application code. Legacy pure-state evidence remains
readable; actual candidate execution requires the new binding.

Export uses the catalog captured by freezing, not today's potentially newer
ledger. Its encrypted snapshot is created from that same captured catalog with
the existing recovery key. The private export intent retains the snapshot and a
unique attempt directory. The build recipe captures the nominated source again,
installs locked dependencies without lifecycle scripts, compiles its application
and ETL, and exports with that captured ETL. The candidate must match frozen
revision, edition, cutoff, membership, configuration and encrypted snapshot.

The lease is renewed during asynchronous builds. Ownership, physical store,
compiled worker and import configuration are rechecked before completion. A
stale worker cannot checkpoint or authorize its output. Publishers must later use
the verified in-memory public byte inventory, rather than reread unchecked files.

Only a verified successful build checkpoints its trusted candidate ID. Validation
then rereads the actual bundle against that ID and the nominated commit, purpose
and base path. Successful stage recovery compares the complete evidence. A changed
application/data file, mismatched snapshot or preview receipt on a release path
fails closed. Private staging, keys, source, reports and journal artifacts are not
public publication inputs.

## Interrupted build policy

The worker saves the export intent before starting the isolated build. If the
process stops before a trusted candidate ID is checkpointed, resume records
`INTERRUPTED_CANDIDATE_BUILD` and fails that attempt. Another invocation builds in
a new private attempt. It retains the unacknowledged directory for diagnosis and
does not adopt its self-reported identity, repeat the import or publish it.
Local isolated building is repeatable; external deployment requires its own
receipt and side-effect recovery, which is still pending.

## Verification and remaining work

GPT-6.1 Sol high tests use real ETL exports, authenticated snapshots, sealed bundles
and the actual candidate verifier. Source capture/build execution is substituted
only in bounded orchestration fixtures; the existing source-build suite and a
separate real reviewed-source full-catalog rehearsal exercise that execution.
A separate Sol high audit identified the missing trusted build-context binding;
it is now fixed and directly tested by changing the saved commit while retaining
identical configuration and refreshing the artifact checksum.

The ten bounded orchestration cases passed, including both unacknowledged-build
interruption points, changed public bytes, purpose mismatch, catalog advance
after freezing, source-context tampering and renewal across a seven-second build
delay with a five-second lease. They yield between synchronous fixture cases so
Vitest can service progress acknowledgements without suppressing errors.

The actual CLI completed eight stages using a disposable copy of all 4,641 events,
one synthetic addition and a real isolated build of preview commit
`dffa4b022ae31addb203b5d8af8e851e9398f432`. It verified the candidate and replayed
without rebuilding or reimporting. Every old event ID, slug and first-added date
remained intact, and three delivery stages stayed pending. The final CLI trial
took 79.632 seconds including setup and replay. The work-in-progress worker's
production catalog digest stayed
`5d2360394cf1242b9cc98e2124a850885cf4df0e49e75eb9249783812e38d0c4`.
No production import, freeze, publication, acknowledgement or schedule ran.

The final full ingestion/component gate passed 563 tests with one skip across 53
files, with exit code zero in 335.89 seconds after the operator's machine reboot.
Strict application/ETL and explicit test-file TypeScript, lint, formatting, Vite
production build and diff checks passed. Forked-worker progress RPC failures were
avoided with thread message channels and a shared event-loop yield; concurrency
stays at four and unhandled errors remain fatal. The four heaviest suites first
passed 90 tests with that transport. Five slow integration cases received narrow
bounded limits; other limits and production lease rules remain unchanged. The
real process-kill fixture now uses a normal lease, confirms the child exited, then
uses the journal's injected clock to fence its expired lease before recovery.

[Publication research](research/github-pages-candidate-publication.md) records
the next delivery boundary and the distinction between a public routing-preview
sibling and exact production-path staging of the immutable release candidate.

Three later stages remain pending: deployment, live verification and
acknowledgement. Durable optional-metadata task intake (#32), explicit successor
generations and unresolved-delivery disposition, automatic acquisition, runtime
and credentials, independent alerts, full private recovery, failure drills and two
observed Friday editions remain required before unattended activation. Existing
reviewed metadata is applied by captured ETL; absent optional metadata is allowed.
This checkpoint does not claim a complete research queue or completed enrichment
coverage.
