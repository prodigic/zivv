# Closed cached Gmail capture admission (#109)

Contract based on PR114. Closed executor implementation is in progress and its
acceptance is unproven. No activation, live catalog load, Gmail request or
credential provisioning is authorized by this packet.

## Fixed active-capture authority probes

The fixed `authority-nested-executor-after-admission` selection calls the actual
exported capture executor recursively with the same genuine full recovery input
inside its active scope, after admission but before key or lease acquisition.
Its existing installation-writer preflight must reject with the exact scope
error. That preflight runs before the later explicit scope-presence check;
neither guard is bypassed to reach a preferred refusal. A fixed read-only
journal observer and whole logical/physical snapshots prove unchanged state
around the nested invocation. The observer always closes, and normal outer
cleanup still revokes the scope and wipes its key before the caller receives a
verified diagnostic. A fresh ordinary invocation must complete and replay.

The fixed `lease-expires-before-source` probe requests a shorter real lease
before acquisition and leaves the private scope deadline unchanged. It waits
for the recorded lease to expire, then calls the normal source-evidence writer.
The ordinary journal ownership check runs before the capture source hook, so
the expected refusal is `Expired or fenced weekly run owner`, not a fabricated
capture-hook error. Normal release must still be attempted and the journal
closed. An observation diagnostic requires proof of both actual refusals,
successful close, unchanged full logical/physical state across the failed
source call, and no source evidence. Final journal bytes may reflect legitimate
lease acquisition and close bookkeeping; final acceptance instead pins the
exact expired owner/fence, unchanged non-ownership evidence and all non-journal
files. No cleanup permission, deadline restoration or expiry reset is granted.
A fresh normal retry must complete using a new fence and real admission time.

The separate `startRecoveryGmailCaptureDriftProbeForTest` launcher adds a fixed
IPC pause/resume seam without changing production launch or binary framing.
It exposes only `paused`, `result`, `resume()` and joined `stop()` controls;
no callback, process handle, message sender, path or data mutation is accepted.
The child requires IPC before admission effects. After admission it enters the
key phase, completes normal outer validation, sends its fixed READY signal and
awaits one fixed GO signal. The pause is bounded by twenty seconds and the
existing scope deadline; it never extends authority. The next actual
`installRecoveredBackupKey` guard must revalidate the changed evidence directly.

The parent test owns a change to an authenticated synthetic batch data file
after READY. It never patches retained worker code or asks the facade to mutate
data. A no-drift control must complete through the same pause/resume path; a
separate tampered-data fixture must refuse before key, intake, result or lease
effects. Compare the full tree around the intentional data change, preserving
all other bytes and logical journal state. Do not restore the changed bytes
before assertions. Stop/timeout/disconnect paths must drain and join the child,
clear protocol listeners/timers and settle both promises. Selecting the mode
without IPC refuses before effects; old workers reject the unknown selection.

The fixed `authority-escaped-after-admission` selection creates one real async
descendant inside the private ALS capture scope after durable admission, before
key installation or lease acquisition. The descendant waits on a private gate.
Normal finalization first deactivates the scope and wipes its in-memory key, then
releases that gate. The descendant attempts the exact admission write through
the real durable writer and must receive `RECOVERY_GMAIL_CAPTURE_EXPIRED` from
its guard before filesystem effects. The coordinator awaits and bounds that
outcome outside the revoked ALS context, compares logical and full physical
state, and returns its safe verified diagnostic only after refusal and unchanged
state are proved. No task or rejection may remain detached when it returns.
This is revocation of an actual inherited scope, not a forged or missing scope
test, and it does not establish active-lease expiry or process-death acceptance.
The observation holds one fixed read-only journal connection from after
admission through the final comparison. Standalone SQLite read connections can
otherwise change SHM timestamps when opening and closing. The observer prevents
that measurement churn while retaining every file, byte, inode and modification
field in the comparison; it grants no journal writer and is always closed.

The fixed `expire-after-admission` selection only shortens the private deadline
after durable admission and before key installation. It then lets the actual
next key-installation guard reject the expired scope; it does not inject an
expiry-shaped error, replace the clock or restore authority. No intake lease has
been acquired, so normal finalization can revoke the scope and wipe its key
without an expired scope blocking lease release. The rehearsal retains the
admission, proves no key/result/intake or ownership change, then requires normal
capture and unchanged saved-result replay on retry. This is before-key expiry
coverage, not proof of expiry during an active intake transaction or lease.
Admission verification can materialize its ordinary read-only journal sidecars:
the rehearsal inventories them explicitly, requires an empty WAL and the normal
bounded SHM file, and compares all pre-existing files before further inspection.

The retained test facade uses the fixed `authority-negatives-before-source`
selection. It runs compiled probes after normal production lease acquisition and
receipt construction, before the first source journal save. The selector exposes
no scope, permit, callback, path override or CLI option. Ordinary capture does
not select or run these probes. Older workers reject the unknown test selection;
their production capture protocol is unchanged.

The probes compare exact logical journal bytes and a bounded physical prepared
tree inventory immediately around each operation, including WAL/SHM bytes,
inode/link identity and modification metadata. Unstable reads are inconclusive
failures. Only after every fixed refusal and unchanged-state check succeeds does
the child return the safe `AUTHORITY_NEGATIVES_VERIFIED` diagnostic. That error
is not a signed completion result. A subsequent normal invocation still has to
complete capture and prove unchanged seeded run/artifact history and saved replay.

For the nested journal-guard probe, the physical snapshots surround the allowed
outer transaction. Inside that transaction the matching-lease borrowed journal
snapshot proves unchanged logical state around the nested refusal. This avoids
raw reads of SQLite byte ranges locked by Windows without excluding those files
from the before/after physical comparison.

Ordinary positive controls establish valid create/save/artifact arguments, valid
snapshot restoration into an empty journal, and catalog initialization and
revision-aware writes. In capture, restore targets its necessarily populated
journal: its exact scope refusal proves the early gate, not an otherwise valid
restore destination. Likewise the unversioned existing-catalog write probes the
entry gate; a separate valid new-catalog initialization probes an operation that
would succeed normally. The import probe proves its entry gate before parsing or
loading, not a successful ordinary import of the synthetic fixture text.

Wrong-scope acquisition and wrong-owner/fence guards retain the distinct Gmail
lease-identity error. Renew/release retain their ordinary fencing rejection;
these are labelled fencing controls rather than Gmail-gate coverage. Nested
journal guard misuse retains its existing error. Snapshot export inside a
matching outer journal guard remains an intentional borrowed read; the export
probe exercises the unguarded transaction path, which must refuse.

This packet does not complete #109: expired/escaped scope, runtime/data drift,
nested retained execution, multi-batch/prospective-parent composition, Monday and
invalid-message cases, hard death, stale lease and lost-response acceptance
remain required alongside the other contract gates below.

The pure evidence checkpoint in
`src/lib/ingestion/recovery-gmail-capture-admission-proof.ts` implements bounded,
domain-separated signed intent/result records and exact original/prior/current
inventory and journal projections. It recognizes journal-before-file restart
states without relaxing the ordinary batch proof. A completed prefix is bound by
an ordered count/digest; all supplied predecessor pairs are still revalidated.
The unfinished admission family must be explicitly supplied and cannot select a
different batch or correction on retry.

These are detached evidence functions, not an executor or permission grant. The
future closed executor must prove complete physical enumeration, runtime and DB
identities, exact lease provenance, and normal MIME/receiver admission before
effects. A saved signed result must be observed before acquiring a new lease and
returned unchanged after a lost response. The admission timestamp records intent;
it never substitutes for the source's actual first observation. Extract and reuse
normal intake's preparation when validating journal-first repair, including every
receiver-profile and sender-date field. `prepareSteveEmailCapture` now exposes
that shared content validation and receipt identity calculation without opening
files or a journal. Ordinary capture uses it too, owns its inputs before parsing
awaits, and retains the real journal admission clock. FULL-message traversal is
bounded to 100 visited parts. This helper does not authenticate Gmail acquisition
or authorize persistence. Draft executor and effect guards are being validated
against the requirements below; their presence is not an acceptance claim.
Detached evidence and returned reports grant no recovery capture/load or
activation permission.

The executor's intent additionally binds `preparedImmutableTreeSha256`: the exact
initial prepared inventory excluding only journal main/WAL/SHM bytes and the exact
platform working-key path. Later selected intake additions are removed from that
comparison only after their individual authenticated delta is proved; the fixed
intent/result/key family is checked separately. Catalog and runtime files remain
included. Before any admission exists, inspection proves the complete original
prepared tree and uses its authenticated journal snapshot with preparation's
specified expiry reset. It does not open SQLite: even a read-only SQLite open can
materialize WAL/SHM files. After durable intent, actual journal snapshots and
separately checked database/sidecar identities govern the permitted logical delta.

## Implementation checkpoint, October 22

The draft closed executor and parent/CLI handoff now pass a genuine retained-worker
fixture with deleted original roots and relocated npm. It exercises read-only
inspection, direct-execution refusal, journal-first interruption, exact repair,
explicit correction, preserved observation and completion replay without a new
lease. The targeted intake/retirement/proof/framing/lease/CLI batch passed 125
checks; the final retained-worker and ordinary installer batch passed eight.
These checks do not prove the complete acceptance matrix below.

Still required for #109: authenticated adoption of complete saved installer/intake
stages, every canonical-file interruption, active-scope SQL/catalog/escaped/expired
and drift probes, multiple selected batches, and Monday/invalid-MIME refusal
rehearsals. Saved stages currently refuse rather than being silently removed.
This checkpoint does not complete #109, #106, #78 or the Friday delivery goal.

The production CLI entry is `operator-recovery.js capture-gmail` with `--file`,
`--key`, `--receipt`, `--destination`, `--npm-cli` and `--batch-id`. Optional
`--corrections-file` points to a private JSON message-ID-to-parent-receipt map.
It accepts no repository, run, workflow, token or activation option. These are
recovery-fixture/operator interfaces, not approval for a live recovery operation.

```ts
interface RecoveryGmailCaptureInput extends RecoveryRuntimeInput {
  batchId: string;
  correctionOfByMessageId?: Record<string, string>;
}
interface RecoveryGmailCaptureReport {
  status: "capture-complete";
  activationAllowed: false;
  captureAllowed: false; // The report grants no subsequent capability.
  batchId: string;
  admissionSha256: string;
  resultSha256: string;
  receipts: Array<{
    receiptId: string;
    sourceSha256: string;
    firstObservedAtEpochMs: number;
    disposition: "ready" | "review-required";
  }>;
}
function resumeOperatorRecoveryGmailBatch(
  input: RecoveryGmailCaptureInput
): Promise<RecoveryGmailCaptureReport>;
// Retained module entry: independently authenticates inputs; never mints from a report.
function executeRecoveredGmailBatchCapture(
  input: RecoveryGmailCaptureInput
): Promise<RecoveryGmailCaptureReport>;
// Dedicated test facade, fixed interruption enum only; no injected executor/permit.
type CaptureInterruption =
  | "admission-saved"
  | "key-installed"
  | "source-committed"
  | "capture-files-written"
  | "result-saved"
  | "admission-stage-flushed"
  | "admission-linked"
  | "key-stage-flushed"
  | "key-linked"
  | "result-stage-flushed"
  | "result-linked"
  | "intake-stage-flushed"
  | "intake-raw-stage-flushed"
  | "intake-raw-published"
  | "intake-source-stage-flushed"
  | "intake-source-published"
  | "intake-receipt-stage-flushed"
  | "intake-receipt-published"
  | "intake-approval-stage-flushed"
  | "intake-approval-published"
  | "intake-manifest-stage-flushed"
  | "intake-manifest-published";
```

The parent and retained coordinator share one fixed interruption whitelist.
The test facade cannot inject a callback or permission. Flushed-stage and linked
checkpoints preserve files only for the private fixed-point interruption error;
arbitrary caller errors retain the ordinary cleanup behavior. These focused
exception-based checks establish exact orphan/alias repair, not supervisor
termination, power-loss durability or stale-lease recovery. Those rehearsals
remain separate acceptance requirements.

Intake file checkpoints distinguish flushed staging bytes from publication of
the canonical RAW message, source text, receipt, correction approval and message
manifest. A publication checkpoint follows normal rename and directory flush,
or the exclusive link when adopting a previously flushed stage. The latter can
leave the one exact canonical/stage alias pair for the next normal leased retry
to clean. File-specific checkpoints still require the private active capture
scope and exact selected path; they are not callbacks or a scope constructor.
The generic `intake-stage-flushed` checkpoint retains its original behavior.

Approval-file acceptance needs a genuinely review-required existing receipt.
A new receipt captured with an explicit correction parent is immediately ready
and does not create a separate approval row/file. Exercise RAW/source/receipt/
manifest interruption on the pending-message fixture; exercise approval on a
second fixture normally replayed without a correction choice before retirement.
Its original review-only source row and first observation stay immutable while
the recovery invocation records and repairs the explicit approval.

1. **Compatibility is a real gate.** Base114 retained workers lack the new entry and the effect guards. They remain stage/inspect capable but cannot execute #109. Refuse `RECOVERY_GMAIL_CAPTURE_UNSUPPORTED_RUNTIME` before admission/key/intake writes. Support starts with newly captured v2 capsules whose exact retained worker contains the reviewed implementation and guards. No copying a new module into an old prepared tree, changing a prepared receipt, resigning original batch bytes, or importing host code into the retained worker. Recovering an already retired older capsule requires a separately reviewed runtime migration, not this feature.

   Authenticated stage repair additionally requires capture executor version 2.
   PR121's executor version 1 does not implement this protocol; the parent and
   coordinator reject that older worker before executing repair. Capture a new
   compatible runtime rather than upgrading a prepared worker in place. This
   executor version is distinct from the capsule format's version.

2. Reuse `openPreparedRuntimeForAdmission`, archive/retirement verification, original-root byte authentication, and exact logical npm relocation proof. Initial admission requires the entire unchanged prepared tree, signed prepared receipt, current Node/ICU/executable/worker/lock/package, existing physical path/link/Git-root validation, and matching physical destination/npm. Preserve the prepared-runtime contract's already allowed internal relative dependency symlinks without widening it. Copy only bounded Buffers after size/type checks. Repeat runtime/receipt/physical checks around computation and effects; never dereference original root/tool paths.

3. Parent and retained child both prove the selection. Parent spawns only the archived `checkout/dist/.../recovery-gmail-capture-admission.js` entry with the existing signed bootstrap module boundary, cwd/worker-root checks and sanitized environment. A distinct executor marker may identify the invocation; it grants nothing. The existing static checkout/npm resolution boundary suffices: no new generated-build module allowance or bootstrap rewrite is needed. Exact expected exports/capability must exist before spawning; an old loader cannot be patched in place.

4. Use a small fixed binary stdin frame: version/magic, bounded canonical metadata, raw archive and retirement Buffers, 32-byte key. Enforce existing envelope limit `256MiB*1.4`, retirement16KiB, metadata64KiB and exact aggregate/trailing-byte rejection before concatenation/JSON parsing. Bind the ordered recipe by canonical digests referencing the immutable batch; do not duplicate RAW/FULL bodies in metadata or admission. Verify worst-case bounds for all100 allowed snapshots, correction entries and4096-byte physical paths before effects; explicitly refuse capacity overflow without truncation. Accept no token, fetcher, Gmail callback, caller account/edition/source, run ID, repository, workflow, or publication flag. Derive account/edition and every RAW/FULL byte from the one authenticated archived batch.

5. Persist and fsync a domain-separated signed immutable admission **before installing a working key or opening a writable journal**. Bind capsule/retirement/checkpoint/prepared-receipt/tree hashes; exact physical root/operator/npm and original logical root; key ID; batch path/hash/ID/account/edition/window/first-save time; ordered snapshot/raw/FULL/source hashes; explicit correction map; exact preexisting canonical receipt/approval evidence and prior completed admission/result digest. Sign intent/selection, not a fabricated future receipt observation.

6. Use a fixed private bounded `recovery-gmail-capture/<batchId>/admission.json` and `result.json` family, outside the operator/checkout subtrees but within the authenticated prepared root; private exact installer stages only. Reuse `installRecoveryIntent`/`readRecoveryInstalledFile` for small exclusive flushed metadata and `installRecoveredBackupKey` with a dedicated exact staging directory. Authenticate before adopting unique complete stages/exact aliases; conflicts, unknown or partial stages remain preserved/refused. Never overwrite a different admission or mint a new timestamp/nonce on retry.

7. One unfinished admission blocks a different batch/correction selection. Completed per-batch pairs remain authenticated evidence; subsequent selected batches require validation of all earlier completed deltas against the original baseline, bounded by the archived batch set (at most1000). Existing receipts shared across batches keep their original observation. This is a fixed per-batch evidence family, not a new general journal or mutable completion registry; do not silently restrict support to the first batch or treat a post-capture tree as a fresh unproved baseline.

8. A new coordinator owns its own private ALS: exact context, selected snapshot descriptors, phases, current message, production lease/fence, deadline and `active`. Only its closed executor establishes it; export guard/query functions, never a mint/with-scope callback, permission Boolean, or original-root allowlist. Reject overlap/nesting with import/retirement/capture contexts. Set inactive in `finally`; escaped tasks and expired invocations fail every effect check. Durable intent is not an expiring permission: a retry establishes a fresh bounded invocation only after full revalidation, without rewriting intent. Keep lease lifetime within invocation budget; expired scopes cannot make new intake writes.

9. `private-artifacts.ts`: add only an effect-specific `"steve-email-capture"` operation, accepted for the exact active capture context. Default operations and `"weekly-import"` stay blocked by quarantine. Never make `hasRecoveredImportAuthority` true for this scope. `assertRecoveredImportInvocation` must reject when a capture scope is active, so no nested normal import/build/freeze/dispatch can begin.

10. `operator-installation.ts`: retain unconditional retirement refusal for this feature; a staged replacement has a quarantine marker, not an own-retirement exception. Add a capture-context effect check to the generic writable assertion. **While capture is active, untagged/general writer calls fail**; narrowly tag only exact intake invocation and journal open/intake/own-lease paths. Existing sqlite-store mutators call the untagged assertion, so they fail before opening/committing catalog SQL. If tagging cannot close every catalog write entry, add an explicit deny hook in those entries; post-hoc catalog comparison is not enough. Outside capture, existing behavior stays unchanged.

11. `weekly-run-journal.ts`: constructor must require the exact existing schema3 prepared journal and guarded main/WAL/SHM identities, never initialize/migrate another DB. Add effect checks **before every SQL mutation**, including paths bypassing `transaction` (`renew` under `guardedLease`). Only production acquire/renew/release for this context's exact owner/fence, and exact selected `source`/`correction` rows are permitted. Central transaction defaults deny under capture; `create`, `save`, stage/artifact writes, restore/import/schema paths, other scopes and unrelated evidence all reject before SQL. A generic installation/quarantine bypass is insufficient.

12. `steve-email-intake.ts`: preserve actual receiver/MIME/edition checks and share their existing pure preparation where useful; never treat batch HMAC as email admission. Guard the exact invocation before and after async MIME parsing, immediately before each source/approval journal commit, and before each directory/file effect. Gate `privateDirectory`/`once` and the durable helper's stage/install/rename boundaries, not merely the outer capture call; a narrow `encrypted-backup.ts` hook is needed for those inner effects and key installer cleanup. Bind original snapshot account/message/RAW/FULL/received/observed hashes, selected correction, derived receipt/delivery/source identities and exact output bytes. Only `message.eml`, `capture.json`, `source.txt`, `receipt.json`, optional exact approval, and their necessary parents for selected messages/bodies may be written; duplicates may reuse a validated original receipt.

13. Keep intake's `admittedAt = Date.now()` and Monday refusal unchanged. Batch save/observation/admission-intent time never becomes first capture time. A new Monday source still refuses; an already journal-committed Friday source can repair files later while preserving its exact first observation. Explicit correction approval retains its actual commit time; never infer newest-message approval. Empty parent values and unrelated, conflicting or competing correction selections fail before widening effects; an empty map requests no new approval. A recipe may reference an earlier unambiguous source in the same batch when no receipt existed at the checkpoint; this is a prospective parent, never an admitted one. Normal intake must actually admit that source as ready before the child's effect. Refuse forward, cyclic, self, ambiguous and known review-only prospective parents.

14. Journal-first restart is a distinct allowed state, not "uncaptured". Authenticate the original baseline plus the exact own added source/approval rows and selected snapshot recipe even if corresponding canonical files are not yet complete. The ordinary full pure proof remains strict and must not be weakened to accept partial evidence. Reinvoke the normal intake path with the same selected snapshot to finish only missing exact files; existing different bytes fail. No new first-observed time, duplicate receipt, or source refetch is permitted after journal commit.

15. Intakes use `writeDurableFile`, which may leave crash-stage files before rename; `once()` alone does not authenticate/adopt them. Stage repair must use a narrowly owned exact-path check: unique complete expected-byte stages/exact aliases may be adopted under the same lease; unknown/partial/conflicting artifacts are retained and fail closed. Installer metadata candidates use the exact target basename followed by one or two `.pid.hex16.tmp` suffixes; intake candidates use exactly one suffix and only the selected account/message/body recipe paths. Authenticate the signed admission, completed prefix and exact prospective bytes before interpreting a candidate as evidence. An admission candidate does not permit SQL/key effects until it is installed canonically. Reuse its exact signed bytes and timestamp; reuse authenticated key encoding rather than generating new ciphertext. Permit two hard links only when the canonical target and its one owned stage are the same inode; a third link refuses. Ordinary unrelated filenames in a shared installer stage directory stay untouched; the capture coordinator separately validates its entire owned metadata namespace. This is not a broad tmp-file omission/deletion rule, and arbitrary partial-file crashes remain outside automatic repair.

16. Each assertion validates the **allowed delta**, not a mutable-directory exemption. Original archive/batches/receipts/approvals and original run rows/artifacts remain byte-identical; all nonproduction ownership remains at the prepared baseline; only known own production lease bookkeeping may change. All added intake rows/files must derive from authenticated admissions and the current exact selected recipe. Check snapshot logical digest and identities, sidecar/DB inode/link safety, and actual physical files before/after each durable effect and before reporting success.

17. Catalog files/sidecars, configuration, weekly state, retained runtime/dependencies/bootstrap, physical npm, prepared/quarantine markers and unrelated intake remain exact. #109 need not open catalog SQL at all: unchanged prepared physical catalog plus original ledger revision is sufficient. Journal logical delta is checked through the existing readonly snapshot mechanism; guard readers inside an active journal transaction must use a consistent visible snapshot without recursively writing/acquiring leases. Never omit whole SQLite/intake trees from proof.

18. Key installation is its own private phase, pinned to the archive key ID and exact destination/stages; no key generation/export or caller-selected key path. Check installed DPAPI/plaintext key equals supplied authenticated key on every retry. Signed terminal result binds admission, exact canonical receipt/approval/capture hashes and its original+prior+own logical evidence projection, normalizing only permitted production lease bookkeeping. Later known completed admissions extend that projection; arbitrary later rows cannot be ignored. It is not a general prepared-tree replacement. Result repair reuses exact bytes. A valid result candidate or canonical result with an owned alias remains `capture-partial` until the retained child installs/cleans it; the parent must not return early. Completion-only cleanup of current or prior authenticated families must not acquire a new capture lease. Lost response after result must verify current own completion and return it without replaying capture effects.

19. Invalid/spoofed RAW/FULL snapshots can legitimately be archived pending evidence. Normal intake must still refuse them, leaving immutable admission and already completed selected messages available for diagnosis/retry. Return safe errors/redacted hashes only; no result claims complete if any selected message remains unadmitted or partial. Do not delete failed admissions to unlock a different selection.

20. Existing PR114 `inspect-gmail` requires an unchanged prepared tree and should continue to refuse post-admission deltas. #109's coordinator/result observer must authenticate its own admission-aware progress instead; do not quietly widen the ordinary inspector or batch reader. Returned success has `activationAllowed:false`, `captureAllowed:false`; it authorizes neither #110 source-to-load nor a freeze/remote operation.

21. Delivery order: (a) reviewed effect-specific journal/installation/intake guard tests with ordinary paths unchanged; (b) pure selection/admission/delta and journal-first repair validators; (c) closed retained executor plus exclusive durable intent/key/result handling; (d) parent facade/CLI and composed fixture. Do not add the quarantine exception before the guards and exact delta validator exist. Root owns integration/CLI/docs; authority owner handles coordinator and scope; bounded fixture work stays separate. A new compatible capsule/runtime is needed for effect rehearsals.

22. Required tests: real multi-message signed acquisition, first message previously captured, delete old roots/tool, prepare relocated exact npm; offline capture with HTTP/token callbacks unavailable; stable duplicates/first observations; explicit correction and review; actual new Monday refusal; interruption after intent/key/source journal commit/each canonical file/result and exact replay/lost-response repair. Include valid complete installer orphans, partial/ambiguous refusal, unchanged catalog/runs/artifacts/config/npm, and multiple selected batches with one unfinished admission blocking another.

23. Authority negatives: direct/forged/expired/escaped/nested scope, wrong capsule/key/preparation/runtime/npm/physical mappings, old worker lacking capability, substituted snapshot/account/edition/RAW/FULL/message/source/receipt/parent, changed admission/result and stage links. Attempt normal import, every journal run/artifact/restore/other-scope mutator, direct catalog transaction/write and arbitrary file path inside capture; each must fail before its effect. Inject drift between outer verification and inner SQL/file check, and retain failed fixtures/process diagnostics.

24. No current capability grants #110 loading or activation. Source-to-load still needs its own selected-ready-receipt admission, fresh canonical context and exact catalog/run delta. This packet intentionally does not solve runtime migration for Base114, automatic partial-file recovery, OAuth provisioning, schedules or live cutover; those boundaries must remain visible in acceptance claims.
