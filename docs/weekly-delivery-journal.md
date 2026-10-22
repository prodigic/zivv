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

If an older checkpoint predates its pending delivery anchors, the worker can now
find the original successful verification in canonical history. It selects a
unique promotion-verification event for the exact private run ID, then checks the
candidate, source, public inventory, release purpose and production base. The
selected bytes must remain a proven ancestor of the authoritative control tip.
Incomplete history (bounded to 1,000 commits and 16 MiB), ambiguous matches or
changed identities stop recovery. Caller-supplied receipt JSON is not authority.

The publication path performs this probe before retention, claim or dispatch.
An exact match recreates the ordinary private deploy/verify anchors and adopts
their evidence without a new remote effect, including after acknowledgement or
a later owner. If no matching verification exists, the existing claim/dispatch
reconciliation path remains in force. The adoption-only path can also recover
this run's historical anchor when the current native operation no longer matches.
The existing explicit adoption of a matching current verified release remains
available for the maintained manual route.

Each recreated anchor is checked again through `readAt` before persistence and
before the stage succeeds. An interruption after persistence resumes the same
artifact. A stage already marked succeeded with its artifact missing remains a
corruption error rather than being silently repaired. This work requires the
coherent earlier journal, sealed candidate, configuration and key; it does not
admit a relocated operator capsule or recreate missing private inputs.

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

## Historical recovery verification

Eight new native Git/SQLite cases and two maintained manual-adoption cases passed.
They cover a restored validate checkpoint after acknowledgement/later ownership,
interruption after anchor persistence, original acknowledgement receipt recovery,
wrong request/candidate/source/inventory bindings, absent/incomplete/ambiguous or
altered history, an unpublished verification fork, missing succeeded-stage
evidence, and a later verified owner reusing the candidate. The complete recovery
case preserves later weekly bytes and catalog digest without another workflow
HTTP request, artifact retention write, native append or application rebuild.
The adoption-only same-candidate case selects the original historical anchor.

The compiled CLI activation and Friday timing batch passed 18 cases. Strict
TypeScript, lint, source formatting, production build and compiled ETL also
passed. Sol-high protocol review checked historical-first selection and repeated
canonical ancestry/request bindings. Full exact-head CI remains a separate check;
these fixtures do not activate a service or replace the fresh-machine drill.
