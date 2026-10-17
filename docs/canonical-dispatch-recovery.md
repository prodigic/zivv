# Recover accepted dispatch intentions from canonical history

An accepted dispatch intention is already durable in the native production
control history. It contains the operation, attempt, workflow and CAS nonce; the
parent state retains the exact release request. Local `pages-dispatch.json`
remains useful but is not the only surviving evidence after machine loss.

When private dispatch metadata is lost, the recovery command can reconstruct the
same record from one nominated canonical attempt:

```text
npm run pages:recover-dispatch -- --workflow-commit REVIEWED_SHA --mode promote --intent-dir NEW_PRIVATE_DIRECTORY --operation-id ORIGINAL_OPERATION_SHA256 --attempt-id ORIGINAL_ATTEMPT_SHA256
```

`rollback` uses the same interface with `--mode rollback`. Both original IDs are
required together and must come from reviewed canonical control history or
retained original receipts. Do not infer a new nonce from a workflow run name,
select the latest owner merely because it is active, or substitute another
attempt. The existing authoritative-origin/main review, token and activation
flag requirements remain unchanged. This implementation sets no flags.

## Proof and authority

The native store reads one authoritative head and validates its legal single-parent
chain. The bounded history projection then returns exact state/parent bytes,
commit IDs and the original canonical `Created-at` timestamp, including
milliseconds. Local unpublished children, forks and orphans are excluded.
Following immutable parents keeps the projection consistent if the remote head
advances while it is read. HEAD, working tree, index and refs are not changed by
history reading; existing transports may fetch immutable objects.

The runner requires exactly one matching `dispatch-intent` transition. It
recreates the deterministic workflow intent from that transition's parent and
recorded nonce, then reproduces the accepted control bytes with the native
reducer. Missing parent/nonce, legacy attempts without a nonce, mismatched
identity, ambiguity or truncated history stop recovery. The query is bounded
to 1,000 returned commits and 16 MiB of state/parent buffers; an incomplete result
does not establish absence or permission to dispatch. These bounds apply after
the store's existing full canonical-chain validation, not to the cost of that
initial authority validation.

Only after proof does the runner durably recreate ordinary recovery-only local
metadata. It preserves the original workflow intent, nonce, expected parent,
accepted commit, exact control bytes and timestamp. A matching historical
admission supplies its original GitHub run ID; otherwise the existing strict
bounded run-list reconciliation applies. Missing, paginated, ambiguous or changed
GitHub results remain uncertain.

Every network call on this route is a GET. It does not ensure/create a workflow
tag, append controller state or send workflow-dispatch POST. An accepted CAS
followed by a crash before POST cannot be distinguished from a lost POST
response. Therefore no-match never authorizes sending again. Repeated invocations
continue reconciling the same operation. A separately reviewed native fencing and
retry transition is required to authorize another attempt.

Existing saved dispatches can also prove their accepted commit through canonical
ancestry after admission, completion or a later owner moved the current control
head. An unpublished prepared commit alone remains insufficient. Successful
reconciliation saves the same run receipt; it does not authorize deployment,
verification or acknowledgement by itself.

## Recovery boundaries

This adapter recovers dispatch authority, not every kind of private state.
Keep the [operator checkpoint](operator-recovery.md), exact catalog, source/report
history, retained payload and compatible runtime. A stale capsule can lack later
catalog changes or acknowledgement intentions. Do not restore old remote control
state or advance the weekly cutoff from a recovered dispatch receipt.

Full machine-loss acceptance remains in [#79](https://github.com/prodigic/zivv/issues/79):
enumerate remaining effect-intention boundaries, recover what canonical history
already proves, and introduce encrypted off-machine private durability only for
facts that cannot be recovered there. Operational path/runtime admission and
old-host fencing remain in [#78](https://github.com/prodigic/zivv/issues/78).
The manual Friday route is preserved; no schedule or live publication changes
are made by implementing this recovery command.
