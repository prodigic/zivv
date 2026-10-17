# Weekly delivery journal adapter

Implementation checkpoint for [#31](https://github.com/prodigic/zivv/issues/31),
stacked on the [acknowledgement executor](verified-weekly-acknowledgement.md).

The weekly worker can now adopt a completed native production deployment and
verification, then call the durable acknowledgement executor. It requires the
same persisted run, sealed candidate, private lease and worker context used for
import, freezing and candidate validation. A supplied receipt alone cannot
authorize acknowledgement.

```text
existing run through validate + exact sealed candidate
  -> native production control proves successful verification
  -> retain immutable control head/hash in private deploy and verify artifacts
  -> journal matching candidate/manifest/deployment evidence
  -> optionally acknowledge with persisted before/after intent
```

## Invocation and boundaries

The existing CLI default still stops after `load`. Explicit `--through verify`
adopts completed delivery; `--through acknowledge` additionally invokes the
acknowledgement executor. Both require `--run-id`, `--candidate` pointing to the
sealed candidate identity JSON, `ZIVV_CONTROLLED_PUBLISHING=enabled`,
`ZIVV_MANUAL_PUBLISHER_JOINED=true` and `GITHUB_TOKEN`. Candidate files must be
regular files without symbolic or hard links. Source arguments cannot accompany
a resumed run. Tokens are passed through the existing scoped Git transport,
never through command arguments or repository configuration.

These flags are activation prerequisites, not proof that the operational
rehearsals have passed. They must remain disabled until the maintained manual
publisher participates in the same native controller and the preview/recovery
rehearsals are accepted. This change does not enable either flag or scheduling.

The adoption-only path does not dispatch or redeploy the candidate. The optional
[publication dispatch adapter](weekly-publication-dispatch.md) connects native
retention, claim and dispatch when a reviewed workflow commit is supplied, and
returns pending until native verification completes. The public
candidate must have `/zivv/` as its base and non-null reviewed application
provenance. The worker also revalidates the retained build with release purpose;
a preview build cannot be adopted for production. Candidate, source commit and full public inventory must match the
native verified operation. Earlier stages still validate their retained artifacts
and the original runtime/source context. A rebuilt runtime cannot silently resume
an older run; explicit context migration remains separate work.

## Recovery and authority

Each private delivery artifact binds the run ID, candidate ID, canonical control
commit and SHA-256 of its exact control bytes. `readAt` validates the current
canonical control chain and proves the retained commit is an ancestor before
returning its bytes. A locally prepared child, fork or orphan cannot serve as
delivery authority. Reading history does not update a branch or the worktree.

An interruption after artifact persistence resumes that same attempt. Once
adopted, both stages use the same retained authority; a later acknowledgement or
new owner does not invalidate an authentic historical verification. Missing or
changed authority, different inventory, changed evidence, stale lease or worker
context stops progress. The final acknowledgement retains its own exact native
append intents and physical writer guards.

CLI delivery failures emit a bounded diagnostic without echoing private Git
errors, paths or credentials. Investigate the retained private journal and native
state, then resume the same run rather than blindly importing or deploying again.

After activation prerequisites are independently satisfied, the explicit resume
commands are:

```sh
npm run weekly:run-import -- --run-id <persisted-run-id> --through verify --candidate <private-candidate-json>
npm run weekly:run-import -- --run-id <persisted-run-id> --through acknowledge --candidate <private-candidate-json>
```

If stopped at this implementation checkpoint, continue using the existing
[manual import commands](journaled-weekly-import.md#run-and-resume) and
[publication procedure](shared-ledger.md#back-up-and-publish). Enabling delivery
is optional and cannot replace the remaining activation checks.

## Remaining acceptance work

Source acquisition through the agent's Gmail connection has been tested, but a
scheduled acquisition adapter is still needed. Manual-publisher participation, repository-state coordination,
portable private recovery, failure notifications, activation rehearsals and two
observed Friday runs remain tracked in the [Friday plan](friday-delivery-plan.md).
No live source, catalog, cutoff, release or native control ref is changed by the
development tests.
