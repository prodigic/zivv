# Closed cached Gmail capture admission (#109)

Design only, based on PR114. No activation, catalog load, Gmail request, credential provisioning, or current private effect is authorized by this packet.

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
receiver-profile and sender-date field. No current API grants the capture/load or
activation operations in the contract below.

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
  | "result-saved";
```

1. **Compatibility is a real gate.** Base114 retained workers lack the new entry and the effect guards. They remain stage/inspect capable but cannot execute #109. Refuse `RECOVERY_GMAIL_CAPTURE_UNSUPPORTED_RUNTIME` before admission/key/intake writes. Support starts with newly captured v2 capsules whose exact retained worker contains the reviewed implementation and guards. No copying a new module into an old prepared tree, changing a prepared receipt, resigning original batch bytes, or importing host code into the retained worker. Recovering an already retired older capsule requires a separately reviewed runtime migration, not this feature.

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

15. Intakes use `writeDurableFile`, which may leave crash-stage files before rename; `once()` alone does not authenticate/adopt them. #109 needs a narrowly owned exact-path repair check: unique complete expected-byte stages/exact aliases may be adopted under the same lease; unknown/partial/conflicting artifacts are retained and fail closed. Do not claim arbitrary partial-file crashes are automatically repairable. If acceptance requires automatic partial-stage recovery, that is an additional reviewed protocol, not a broad tmp-file omission/deletion rule.

16. Each assertion validates the **allowed delta**, not a mutable-directory exemption. Original archive/batches/receipts/approvals and original run rows/artifacts remain byte-identical; all nonproduction ownership remains at the prepared baseline; only known own production lease bookkeeping may change. All added intake rows/files must derive from authenticated admissions and the current exact selected recipe. Check snapshot logical digest and identities, sidecar/DB inode/link safety, and actual physical files before/after each durable effect and before reporting success.

17. Catalog files/sidecars, configuration, weekly state, retained runtime/dependencies/bootstrap, physical npm, prepared/quarantine markers and unrelated intake remain exact. #109 need not open catalog SQL at all: unchanged prepared physical catalog plus original ledger revision is sufficient. Journal logical delta is checked through the existing readonly snapshot mechanism; guard readers inside an active journal transaction must use a consistent visible snapshot without recursively writing/acquiring leases. Never omit whole SQLite/intake trees from proof.

18. Key installation is its own private phase, pinned to the archive key ID and exact destination/stages; no key generation/export or caller-selected key path. Check installed DPAPI/plaintext key equals supplied authenticated key on every retry. Signed terminal result binds admission, exact canonical receipt/approval/capture hashes and its original+prior+own logical evidence projection, normalizing only permitted production lease bookkeeping. Later known completed admissions extend that projection; arbitrary later rows cannot be ignored. It is not a general prepared-tree replacement. Result repair reuses exact bytes. Lost response after result must verify current own completion and return it without replaying capture effects.

19. Invalid/spoofed RAW/FULL snapshots can legitimately be archived pending evidence. Normal intake must still refuse them, leaving immutable admission and already completed selected messages available for diagnosis/retry. Return safe errors/redacted hashes only; no result claims complete if any selected message remains unadmitted or partial. Do not delete failed admissions to unlock a different selection.

20. Existing PR114 `inspect-gmail` requires an unchanged prepared tree and should continue to refuse post-admission deltas. #109's coordinator/result observer must authenticate its own admission-aware progress instead; do not quietly widen the ordinary inspector or batch reader. Returned success has `activationAllowed:false`, `captureAllowed:false`; it authorizes neither #110 source-to-load nor a freeze/remote operation.

21. Delivery order: (a) reviewed effect-specific journal/installation/intake guard tests with ordinary paths unchanged; (b) pure selection/admission/delta and journal-first repair validators; (c) closed retained executor plus exclusive durable intent/key/result handling; (d) parent facade/CLI and composed fixture. Do not add the quarantine exception before the guards and exact delta validator exist. Root owns integration/CLI/docs; authority owner handles coordinator and scope; bounded fixture work stays separate. A new compatible capsule/runtime is needed for effect rehearsals.

22. Required tests: real multi-message signed acquisition, first message previously captured, delete old roots/tool, prepare relocated exact npm; offline capture with HTTP/token callbacks unavailable; stable duplicates/first observations; explicit correction and review; actual new Monday refusal; interruption after intent/key/source journal commit/each canonical file/result and exact replay/lost-response repair. Include valid complete installer orphans, partial/ambiguous refusal, unchanged catalog/runs/artifacts/config/npm, and multiple selected batches with one unfinished admission blocking another.

23. Authority negatives: direct/forged/expired/escaped/nested scope, wrong capsule/key/preparation/runtime/npm/physical mappings, old worker lacking capability, substituted snapshot/account/edition/RAW/FULL/message/source/receipt/parent, changed admission/result and stage links. Attempt normal import, every journal run/artifact/restore/other-scope mutator, direct catalog transaction/write and arbitrary file path inside capture; each must fail before its effect. Inject drift between outer verification and inner SQL/file check, and retain failed fixtures/process diagnostics.

24. No current capability grants #110 loading or activation. Source-to-load still needs its own selected-ready-receipt admission, fresh canonical context and exact catalog/run delta. This packet intentionally does not solve runtime migration for Base114, automatic partial-file recovery, OAuth provisioning, schedules or live cutover; those boundaries must remain visible in acceptance claims.
