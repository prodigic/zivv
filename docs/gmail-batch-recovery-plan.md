# Authenticated Gmail batch portability (#106)

Implementation plan. [PR #111](https://github.com/prodigic/zivv/pull/111) delivers
the detached proof with nine focused tests; [PR #112](https://github.com/prodigic/zivv/pull/112)
adds authenticated capsule preservation and staging with six dedicated cases and
the existing operator regressions. [PR #114](https://github.com/prodigic/zivv/pull/114)
adds read-only replacement-host inspection with eleven native prepared-runtime
and CLI cases. Closed capture (#109) is the next required authority step.
The [closed capture contract](recovery-gmail-capture-contract.md) records its
effect-specific journal guards, retained-worker compatibility and required drills.
The current focused authority rehearsal uses a fixed retained test selection
before source commit, with ordinary journal/catalog positive controls and exact
per-operation refusal/state checks. Its scope and early-entry-check limitations
are recorded in that contract; it does not replace multi-batch, expiry/escape,
drift, hard-death or selected-receipt-load acceptance.
These stages replace the baseline's blanket acquisition-tree refusal with exact
authenticated support; recovery remains incomplete until closed capture,
selected-receipt loading and composed acceptance below are verified.

## Reuse the capsule and preserve signed bytes

Add `email-acquisition` to the existing operator tree classification, with an
exact `batches/<batchId>.json` grammar and no arbitrary descendants. Keep capsule
versions 1/2, encrypted envelope, inventory hashes, retired-source receipt and
standard staging/preparation. Add one pure key-aware batch-inventory verifier,
called by capture finalization, encrypt/decrypt and stage before effects. It
checks batch HMAC/key ID against the **archive key**, filename/derived batch ID,
original operator binding, account/edition/window, ordered complete snapshots,
RAW/FULL/source identities and timing. Batch save time must not exceed checkpoint
time. It needs no original filesystem, Gmail account or OAuth callback.

Preserve every original batch byte, signature, observation and registration time;
never resign, rewrite its operator path or use restore time as acquisition time.
Validate captured-message relationships against the checkpoint's logical journal
and intake files, including duplicate message manifests sharing one canonical
receipt. Missing capture is a legitimate pending obligation; inconsistent existing
capture/receipt/source evidence is not completion.

Before taking the capture locks, reuse the existing writable staging repair to
adopt only unique complete authenticated orphans/exact aliases, without HTTP or
message capture. Then require a clean canonical registry under capture's existing
production lease/catalog lock and repeat inventory verification before finalize.
A late stage, partial stage, ambiguous same-ID stages or unrelated link refuses
**before fencing**, retaining all evidence for diagnosis/retry. This preserves
exact batch content while avoiding a new portable hard-link/stage format. No
unknown stage is silently omitted. Standard prepared trees keep their nlink=1
contract; do not normalize restored evidence behind their receipt hashes.

Keep 32 MiB +64 KiB per batch, 1,000 entries and 256 MiB registry preflight.
The capsule's existing 256 MiB **clear JSON** limit also applies to ledger,
journal, worker and base64 files together: a near-full registry may not fit.
Fail explicitly before archive/fence, never truncate or silently increase legacy
limits. Supporting every maximum-size registry would require separate bounded
archive/retention work, not a claim made by this reuse design.

## New-host reads and closed offline capture

Use `prepareOperatorRecoveryRuntime` unchanged with the exact archive/retirement
pair and matching reviewed runtime/npm package. Delete the old roots/tools in the
rehearsal. Staging restores all canonical batch bytes; it installs no activation
or general Gmail writer permission. A new readonly
`inspectOperatorRecoveryGmailBatches(RecoveryRuntimeInput)` authenticates the pair,
prepared receipt/physical inventory and batches and returns redacted capture/load
obligations. It can use the supplied key before working-key installation, without
creating a key, writer, token request, alias repair or source receipt.

Do not add `allowRelocated`, caller-selected original root or a public permit to
the ordinary batch reader. A private, expiring ALS read context is minted only
by the closed inspector/coordinator after full proof. It binds the capsule and
retirement hashes, prepared receipt, exact new root/operator, original logical
operator and retained batch path/byte hashes. Inside that context the reader reads
new physical files but verifies their unchanged signed **original** root. Every
query rechecks current physical/context evidence; ordinary copied batches still
fail. No original path is dereferenced. Outside the scope quarantine is unchanged.

A separate `resumeOperatorRecoveryGmailBatch({...RecoveryRuntimeInput, batchId,
correctionOfByMessageId?})` performs offline **capture only** through the retained
worker/bootstrap boundary. Both parent and worker authenticate the selected batch
and exact preparation. Persist a small signed admission before working-key/intake
effects, binding all context hashes, batch bytes/account/edition/source set and
explicit correction selection. No `getAccessToken`, fetcher, new batch, candidate,
freeze, publication or remote append is accepted. A private capture phase accepts
only each retained RAW/FULL snapshot and its configured identity. Intake rechecks
this exact scope before journal commits and guarded file effects; ordinary email
capture remains blocked. Reuse per-receipt journal-first durability and repair.

The allowed delta is only selected message/body/correction evidence, expected
intake rows and production ownership bookkeeping, plus admission/result/key files.
Catalog, original runs/artifacts, other intake and all runtime/configuration bytes
remain exact. Recheck those invariants before/after effects and on retry; never
exclude the entire intake tree or journal from authority proof. Existing receipts
keep first observation. New receipts use actual admission time; Monday replay of
an uncaptured source still requires review. No newest-message approval is inferred.
Return activation=false, batch/receipt/source hashes, counts and dispositions only.

Current run-only import admission explicitly rejects `source` and pins an already
retained run. It cannot load a newly captured receipt. Offline batch portability
therefore does **not** activate it or authorize a new weekly run. End-to-end #78
requires a further closed selected-receipt source-to-load admission: exact resolved
ready receipt/source/observation, normal deterministic run identity and artifacts,
fresh canonical baseline, durable retry and a proved catalog/journal delta through
load. If #106 acceptance includes loading, that phase is required within #106;
capture-only must not be presented as its completion. General activation remains
a separate reviewed cutover in either case.

The current integration seams are `listRetainedSteveEmailSources` in
`steve-email-intake.ts` (validated receipt/source resolution),
`loadRetainedSteveEmailSources` in `steve-email-load.ts` (loads **all** ready
retained sources), and `assertRecoveredImportInvocation` in
`recovery-import-admission.ts` (rejects source-based invocation in the existing
run-only scope). The all-ready loader is not a selected-receipt executor.
Extract/reuse normal deterministic import behavior behind a separately reviewed
exact-receipt admission; do not reuse a capture result as import permission or
widen the existing run-only scope to accept arbitrary source bytes.

## Required acceptance and ownership

1. Actual fake-API two-message batch, interrupted after first receipt; normalized
   complete stage; capture+retire, delete old operator/checkout/npm, prepare with a
   real relocated package. Read obligations and replay cached capture with all
   HTTP/token callbacks unavailable. Preserve original batch bytes and admitted
   observation; admit only the previously uncaptured message at current time.
2. Interrupt new-host journal-before-file capture; repair/replay without duplicate
   receipts. Prove catalog/original journal unchanged and quarantine/worker limits;
   unrelated batch/run/source/correction map/parent, nested/escaped scope and
   runtime/dependency/file drift refuse. Exact approved correction works; Monday
   new admission fails without losing cached evidence.
3. Wrong key, valid-HMAC wrong original root, substituted capsule/preparation,
   tampered RAW/FULL/hash, duplicate identities and unknown inventory paths refuse
   before staging/intake/fence. Complete orphan/alias preserves exact bytes;
   partial/ambiguous/foreign links and capacity overflow preserve state/no fence.
4. Existing batch-free capsules/versions/manual commands remain compatible. Version
   1 remains offline-stage/read capable; retained execution still requires the
   existing version-2 bootstrap tool identity. No in-place worker upgrade.

Sol owns pure authenticated inventory/read mapping and closed capture authority;
root integrates operator capture/stage/runtime/CLI and acceptance. Routine fixture
and corruption tests can be bounded separately when agents are available. No
schema/journal migration, automatic pruning, scheduler or live activation follows
from this packet.

## Incremental delivery

1. Pure key-aware batch/inventory proof under #106, with no tree whitelist or permissions change.
2. Capsule capture/encryption/decryption/staging integration and immutable new-host reads under #106; retain pre-fence refusal until all required verifiers are installed.
3. [Closed cached-batch capture admission (#109)](https://github.com/prodigic/zivv/issues/109).
4. [Closed selected-receipt source-to-load admission (#110)](https://github.com/prodigic/zivv/issues/110).
5. Composed deleted-host, lost-response, cutoff and quarantine refusal drills for #106/#78/#38.

These are required work items, not completion claims. Every step retains the manual Friday path, and no implementation step authorizes a live cutover or schedule activation.

## October 28 native composition checkpoint

The IPC lifecycle/order checkpoint is [PR #140](https://github.com/prodigic/zivv/pull/140). Its stacked composition follow-up adds the actual deleted-host rehearsal in `src/test/ingestion/recovery-gmail-capture-multibatch-runtime.test.ts`:

| Evidence          | State at retirement                                          | Recovery                                                                                                 |
| ----------------- | ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| ORIGINAL batch a1 | Captured, ready source for edition A                         | Exact receipt, source, signed batch and first observation preserved                                      |
| PRIOR batch b1    | Signed pending correction for edition A, same account        | Interrupt after journal source commit; repair using a1 as parent without replacing the saved observation |
| OWN batch c1/d1   | Signed pending two-message batch for edition B, same account | Capture c1 ready, then d1 with c1 as the prospective correction parent                                   |

All three batches are created through separate normal `captureSteveGmailWindow` calls with synthetic Gmail RAW/FULL responses. The next edition is deliberate: ordinary acquisition must replay pending work for the same edition first. This fixture neither mocks that replay nor rewrites/resigns retained batch evidence to manufacture two pending batches. Shared MIME preparation derives expected receipt IDs from the actual authenticated snapshots; those computed identities are not represented as already admitted receipts.

The original checkout, operator directory and npm tree are deleted before capture recovery. The retained worker repairs PRIOR, then captures OWN through the public closed entry. OWN's signed admission binds the exact completed PRIOR admission/result hashes. Both pairs remain byte-identical after replay. Original catalog/configuration/runtime/batch/intake inventory and existing run/artifact rows remain exact; only the permitted capture family and journal bookkeeping change. General quarantine access and activation remain denied.

The composed case passed in **190.57 seconds**. A first run correctly reached both captures but failed a test assumption equating signed intent time with source admission time. The corrected test preserves exact acquisition timestamps, bounds each new first observation by the real recovery/source window, verifies parent-before-child ordering and proves that interrupted/replayed observations never change. The failed isolated fixture was retained; no retained worker was patched in place.

This is positive native composition evidence, not completion of #109/#106/#78. Remaining clock/corruption/crash/refusal/portability coverage and #110's distinct selected-ready-receipt load authority still require their own acceptance. No live retirement, ledger/cutoff mutation, scheduling activation or publication was performed.
