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

## Full capture-family projection checkpoint, October 28

`proveRecoveryGmailCaptureFamily` reuses the capture admission proof's ordered
completed-prefix reconstruction for downstream selected-receipt loading (#110).
It authenticates every supplied completed admission/result pair against the
original checkpoint and all predecessors, then validates either the exact
completed inventory or one authenticated unfinished tail using the normal delta
proof. Journal-first partial evidence and capture-complete evidence without a
signed result remain distinct from completed admission/result pairs.

The returned domain-separated family commitment binds the original inventory,
ordered pair hashes, unfinished admission hash, current projection and complete
current journal digest. The returned inventory is detached, contains only
files/directories/journal, and does not reissue the changed tree as a new
checkpoint or change the original checkpoint timestamp. Activation, capture and
load flags remain false. A physical enumerator still must establish the complete
observed family, match its commitment and independently revalidate runtime,
physical identities and current bytes; this pure helper cannot establish that no
family file was omitted from its input.

Focused admission/selection validation passes 28 checks, including six new family
cases: original-only, detached completed projection, journal-first tail,
omitted/duplicate/reversed/corrupt family refusal, full two-pair composition and
unrelated file/journal/ownership rejection. The composition case also accepts a
completed prefix with a capture-complete but unsigned-result tail and binds its
family differently. Compilation, publication TypeScript, lint and formatting are
separate static checks; this checkpoint adds no native executor acceptance claim.

This is a prerequisite for #110, not selected-receipt load completion. Exact
ready-receipt/RAW/source/correction resolution, full catalog and rules baseline,
durable closed admission, normal deterministic loading, exact catalog/run delta
and crash/lost-response/replay acceptance remain required. No writer scope,
quarantine exception, live operation, freeze or publication is introduced.

## Exact selected-receipt proof checkpoint, October 28

`proveRecoveryGmailSelectedReceipt` accepts the full capture-family input and one
closed `{batchId, messageId, rawSha256, receiptId}` selector. It revalidates all
completed predecessors and any unfinished tail, then derives batch membership,
canonical receipt identity, exact source hash, edition, delivery and original
first observation from authenticated retained evidence. It never accepts caller
source bytes, account/edition replacements, run IDs or a load permission.

The internal full-family resolver can reconstruct the canonical validation view
of a journal-first tail. That view stays private: the selected receipt, its
primary delivery, selected duplicate delivery, correction ancestors and any
approval must all have their exact canonical files in the actual observed
inventory. A missing canonical file remains capture-pending even when its source
journal row has committed. A different original ready receipt can still be
selected; unfinished unrelated obligations are retained rather than making all
selection fail. The original checkpoint remains the trust anchor. A private
current-time validation horizon admits already-authenticated later observations
without changing any receipt timestamp or returning a replacement checkpoint.

Duplicate deliveries bind their own RAW and capture manifest while retaining the
first canonical body receipt and observation. Gmail RAW SHA256 and plaintext
source SHA256 remain separate. Effective readiness and correction lineage reuse
the strict batch inventory resolver, including exact canonical approval bytes.
The selected output commits the entire family, canonical selected/ancestor
files, derived source descriptor and all batch-message obligations. Its ready
status describes capture readiness, not successful loading or freeze eligibility.
All activation/capture/load flags remain false and physical validation remains
required. No RAW or plaintext body is returned.

Focused proofs cover original and later batch selection, duplicate delivery,
explicit correction ancestry, ordinary review/approval without changing first
observation, partial canonical evidence, unapproved correction, omitted family,
wrong selector identities, RAW/plaintext substitution, source/clock drift,
accessor/symbol controls and detached outputs. These are detached proofs over
ordinary synthetic acquisition/intake evidence; they do not claim deleted-host
selected-load execution or catalog mutation acceptance.

Still required for #110: physical complete-family enumeration and exact current
identity/byte checks; fresh full catalog/journal/runtime/rules/configuration
baseline; normal deterministic run identity; durable closed signed admission;
selected source-to-load execution; exact catalog/run/receipt/artifact delta;
crash, lost-response and replay acceptance; preserved pre-cutoff freeze blocking.
This checkpoint does not widen the run-only recovery entry or general quarantine
access, and does not complete #110, #106/#78 or the full Friday delivery plan.

## Selected-load baseline checkpoint, October 28

`proveRecoveryGmailSelectedLoadBaseline` composes the exact ready-receipt proof
with a complete validated canonical catalog and journal baseline. For the first
selected load, the current catalog must equal the original checkpoint's full
ledger and revision digest, including entity content, stable slugs and import
history. Counts alone are insufficient. The proof binds the complete current
journal, selection/obligations and observed runtime identity. It is detached
evidence: it does not open SQLite, establish physical freshness or acquire a
writer capability.

`weekly-run-context.ts` now supplies the shared pure worker-inventory,
configuration and rules digests used by the normal source builder, import review
and weekly runner. Configuration includes the same fixed five policy files and
explicit absence. Recovery independently derives the worker digest from all
captured lib/types/utils file commitments, checks the captured lock and Node/ICU/
executable identity, and derives configuration from authenticated captured files.
Frozen pre-extraction byte fixtures verify the worker/configuration/rules hash
algorithms remain compatible. New reviewed code still changes the worker hash as
usual; this does not bypass retained-runtime identity checks.

The proof constructs the source using the canonical plaintext hash and original
receipt observation, then calls normal `createWeeklyRunState`. An existing exact
run is reused only after source/revision validation and verification of its
original acquisition artifact. No caller run ID or rules hash is accepted.
All activation/capture/load flags remain false; physical validation remains
required. The original checkpoint is not replaced by a post-capture baseline.

The current first-load proof explicitly refuses nonempty prior selected-load
evidence. Later loads still require a full load-family delta composer; this is
unfinished scope, not a permanent first-load-only design or permission to drop
prior evidence. The future closed admission must bind archive/preparation and
physical identities, authenticate complete observed capture/load families, read
canonical SQLite under serialization, and revalidate baseline/runtime/current
bytes around every effect. Exact catalog/run/artifact delta and crash/lost-response/
replay acceptance remain required before #110 or through-load recovery is complete.

Focused coverage includes a normally reconciled nonempty catalog, same-count
metadata/slug drift, runtime/worker/lock/Node/ICU drift, config drift, refusal of
unproved prior loads, normal run identity, retained-run acquisition evidence and
detached outputs. Ordinary runner controls cover normal four-stage loading,
committed-catalog/journal-gap recovery without duplicates and changed-policy
refusal. No live ledger, cutoff, merge, deployment or activation operation occurs.

## Signed selected-load intent checkpoint, October 28

`createRecoveryGmailSelectedLoadAdmission` and
`authenticateRecoveryGmailSelectedLoadAdmission` define the closed first-load
intent envelope. It binds the prepared host/capsule/retirement/checkpoint/key,
complete baseline/family/selection/catalog/journal/runtime commitments, exact
selector and normal source/run/revision/state, and original admission time.
The only target is `stopAfter: load`. Activation/capture/load flags stay false:
signed intent is evidence, not an executable capability.

The domain is `zivv-recovery-gmail-selected-load-admission/v1` followed by NUL.
Records are bounded at 64 KiB, strict canonical UTF-8 JSON plus one newline,
with a domain-separated HMAC-SHA256. Authentication recomputes the full original
fresh baseline and requires the exact record schema and fields. Wrong domains,
keys, hosts, sources, runs, refreshed-but-different catalog baselines and even
valid-HMAC payload substitutions refuse. One supplied unfinished intent blocks
any different selection/baseline/host/time, and a matching retry returns a
detached copy of its exact saved bytes rather than resigning it. Physical family
enumeration is still required to establish that no unfinished intent was omitted.

`recovery-host-binding.ts` shares capture's host-identity rules without changing
canonical capture payload fields or signature domains. During canonical-byte
validation, a targeted red test found that the old capture decoder stripped a
UTF-8 BOM before comparing JSON text. Capture now compares original bytes with
the canonical encoding, as selected-load admission does. Both BOM-prefixed intent
and result records refuse; valid canonical records retain their existing format.
Do not rewrite or resign a noncanonical retained record as an automatic repair.

This checkpoint signs/authenticates buffers only. It does not install or flush an
intent/baseline file, install a key, open a writable journal, create an ALS scope
or load a catalog. The retained closed executor must persist exact intent and
necessary original-baseline evidence before key/writer effects, independently
revalidate physical/runtime/family identity, establish only its bounded private
scope and verify every effect. After load effects, a separate exact load-delta
proof must explain current changes against the original admitted baseline;
changed current evidence must never be adopted as a new baseline for retry.
Signed result and later-load family composition remain required, as do native
selected-load crash/lost-response/replay and all remaining delivery acceptance.

## Original selected-load baseline evidence checkpoint, October 28

`recovery-gmail-selected-load-evidence.ts` defines private baseline evidence bytes
for crash recovery. The manifest is canonical UTF-8 JSON/newline, HMAC-bound to a
separate `zivv-recovery-gmail-selected-load-baseline-evidence/v1` NUL domain. It
binds the exact original checkpoint, signed intent, complete ordered capture
family references and unfinished-tail snapshot. It does not copy the ledger,
original RAW messages, unchanged run/artifact history or completed capture
admission/result bodies. Those remain in their authenticated original evidence.

`compactRecoveryGmailCaptureInventory` and its restore companion reuse the normal
capture-family proof and canonical evidence derivation. Completed prefixes are
rebuilt from their original signed pairs. Only the unfinished tail's additional
source/approval rows, present canonical file commitments, directories and exact
production ownership are retained. Missing journal-first canonical files remain
missing; the reconstruction never promotes the private completion view into
physical file presence. Producer-side replayability is checked before encoding.

Each tail source/approval row is a separate digest-addressed chunk, at most 8 MiB.
There are at most 200 chunks and 256 MiB aggregate row bytes; the manifest remains
bounded at 16 MiB. These limits follow existing capture/journal bounds and fit the
existing 16 MiB per-file immutable installer without widening it. No chunk path
is accepted from a caller: the codec returns opaque fixed hash IDs and bytes.
Missing/extra/duplicate/altered chunks or capture predecessors refuse. Original,
completed-prior and unfinished-own evidence compose without duplicating prior
rows. All referenced prior evidence must remain retained.

Restoration checks the observed intent bytes (or explicit absence for validating
an orphan artifact), exact checkpoint and capture family, chunks, reconstruction,
and the original signed baseline. It returns detached original-baseline data and
no recovery key. Null intent observation is not adoption or load permission.
This restores the ORIGINAL baseline, not a claim about the current physical
catalog/journal after a load. All activation/capture/load flags stay false and
physical validation remains required. Current effects must still be explained by
the later load-delta proof against this original baseline before any retry.

The codec performs no filesystem installation, key installation, SQL, execution
scope or load. Next, the closed retained coordinator must authenticate and install
all row chunks and the manifest before publishing the exact intent, then validate
complete physical family/runtime/SQLite identity and establish only its bounded
scope. Interrupted stages/orphans, corruption, exclusive serialization, exact
load delta/signed result, native deleted-host crash/lost-response/replay and later
load-family composition remain required. This is not a second ledger or a success
receipt, and does not complete #110 or the full Friday delivery plan.

## Physical selected-load inspection checkpoint, October 28

`inspectRecoveryGmailSelectedLoadAdmission` observes an actual prepared host before
load installation. It reuses the complete capture host verifier through a fixed
private read-only mode, deriving the active capture from the authenticated family
rather than trusting the caller to choose which family to observe. A ready
receipt from the original batch can therefore be selected beside a genuinely
interrupted different capture without dropping either obligation.

The low-level host snapshot returns detached data only: no recovery key, open
handle, validation callback or scope constructor. It authenticates original
retirement/preparation/runtime/npm, complete ordered capture intent/result family,
canonical intake and logical journal, working-key evidence and unchanged prepared
files. The catalog is certified by exact unchanged prepared-file-tree identity,
not a stale workspace ledger or a new writable SQLite observation. Staging had
already verified the restored catalog digest. This first-load observer rejects
even metadata-only SQLite generation drift with an unchanged logical digest.
A transaction-owned fresh canonical read is still required by the future writer.

The public report is explicitly pre-load-only. It includes opaque commitments,
normal source/run identity, counts, capture-repair status and message-hashed
obligations; no RAW body, key, physical path, live handle or clear Gmail message
ID is returned. It requires a matching archived inspection entry and refuses an
unsupported capsule before destination preparation or any installer/key effects.
The existing run-only recovery mode and default capture selection rules remain
unchanged. All activation/capture/load flags remain false and physical
revalidation is still required before future effects.

The native fixture verifies deleted original roots and relocated npm, original
ready selection beside actual source-committed interruption in another batch,
unchanged physical/logical state, preserved observation and quarantine, and the
subsequent completed capture family. A deliberate SQLite generation-only change
then refuses without further state changes. A separate genuine missing-entry
capsule refuses before creating a destination. It is left unprepared because the
current host correctly refuses to prepare a different archived worker inventory;
no retained worker or signed receipt is patched to simulate compatibility.

Read-only journal observation can involve SQLite sidecar bookkeeping. Native
before/after measurements pin a real read observer so that opening/closing the
measurement itself does not masquerade as an inspector mutation. This is not a
new journal writer or a claim that a read report grants ownership.

This observer does not install artifacts or support post-load physical changes.
The next closed coordinator must bind exact current physical/stage membership,
recognize only its fixed per-run evidence namespace, install row chunks/manifest
before the exact intent and before key/writer effects, and revalidate around each
effect. Present load changes still need an exact delta/signed-result proof against
the original admitted baseline. Stage repair/adoption, bounded source-to-load
scope, native crash/lost-response/replay and later-load family composition remain
required for #110 and through-load recovery. No activation or full-goal completion
is established by successful inspection.

## Original physical inventory commitment, October 28

The selected-load signed intent now requires the exact original physical
inventory SHA-256 supplied by the physical adapter. The retained baseline manifest
binds the same commitment to the embedded signed intent. Changed, absent,
noncanonical or accessor-supplied commitments refuse admission; an unfinished
intent cannot be retried against a newly observed physical tree. Re-signing only
the baseline manifest with a different physical commitment also refuses because
its embedded intent must authenticate against that same value.

This extends the unreleased version-one development format: earlier development
intent/evidence bytes without this required field refuse rather than receiving a
default. The pure codec does not establish that a caller-provided hash is a real
observation. The closed coordinator must obtain it directly from the verified
host inventory, install evidence before intent/key/writer effects, and validate
present physical state plus the exact allowed load delta. Restoring original
evidence returns its original commitment and still requires physical validation;
it never claims the current tree equals the original after load effects.

## Closed selected-load evidence installation, October 28

`installRecoveryGmailSelectedLoadEvidence` composes the observed original physical
host, selected receipt baseline, signed intent and retained baseline manifest
inside one synchronous coordinator. The caller supplies only the ordinary
recovery inputs and exact receipt selector. It cannot supply a run, source,
clock, filesystem target, callback, catalog or executor.

The only new namespace is `recovery-gmail-load/<normal-run-id>/`: `baseline.json`,
`chunks/<chunk-id>.bin`, `admission.json` and their exact private installer stage
directories. Normal run IDs are the full 64-character source-identity hash.
The baseline manifest is installed first, then all row chunks, and the exact
intent last. A flushed orphan baseline supplies its original signed admission
time on retry; the fresh physical/logical host must still authenticate against
that original intent before any adoption or ACL change. Regenerating the packet
must reproduce the complete saved manifest, so unknown fields, sibling runs,
files or chunk bytes cannot be adopted as an arbitrary exemption.

The fixed-purpose host adapter enumerates the full runtime, while the closed
coordinator accounts for every load-namespace member against exact regenerated
bytes, paths and directory membership before effects. The rest of the host must
match the original admitted physical inventory and logical capture family.
Runtime enumeration recognizes only complete, matching two-link installer alias
pairs for the exact normal-run layout; ordinary capture and generic inspection
still refuse the load namespace. The raw detached adapter observation grants no
namespace validation or write authority by itself.

A private revocable context allows only those exact evidence files and installer
aliases. Every file/ACL/adoption boundary revalidates the host and namespace.
Catalog, source capture, journal, backup-key, retirement and other recovery scopes
are excluded. Successful installation still reports `loadAllowed: false` and
requires fresh physical validation. It does not execute the selected load or
prove post-load catalog/run deltas. The production launcher, final bounded loader,
transaction-owned canonical read, complete crash/hard-death/authority acceptance,
signed load result and later-load family composition remain required.

Focused evidence for this checkpoint: the retained native installer fixture passed
in 235.48 seconds, covering flushed-manifest retry, manifest and chunk publication,
linked-intent recovery, stable replay and unknown-file refusal. A separate original
ready/no-working-key control and input refusal passed in 83.59 seconds. Existing
physical capture/inspection compatibility cases passed in 113.03 seconds, and 63
pure family/selection/baseline/intent/evidence cases passed in 36.34 seconds (69
unique focused cases overall). Worker and publication types, lint and formatting
passed. The first native attempt exposed the mistaken candidate-directory run-ID
pattern; runtime inventory correctly refused its linked manifest. The exact normal
64-hex run-ID pattern was corrected, and the original failed `k7xwCc` fixture and
worker remain unchanged. No complete hard-death or selected-load execution claim
is made by these checks.

## Retained selected-load installation launcher, October 28

The launcher owns a strict bounded `ZGLF` version-one binary frame before its first
asynchronous boundary. Only archive, retirement evidence, the recovery key,
destination, npm identity and exact receipt selector are accepted. Unknown
controls, accessors, extra frames, malformed lengths/UTF-8 and noncanonical JSON
metadata refuse. Capture's separate `ZGCF` frame cannot dispatch this operation.
Keys are passed on stdin and owned copies are wiped; source bytes and credentials
are not embedded in process arguments or child diagnostics.

Archived installer capability two and framing capability one are required before
preparation or launch. Capability two adds a genuinely read-only canonical
completion verifier. It rejects incomplete or staged installation without
adopting, flushing or changing permissions. The launcher returns an already
verified complete receipt immediately; otherwise only a coherent, authenticated
incomplete installation may invoke the exact retained entry through the existing
bootstrap module boundary. The child independently authenticates the operation.

The parent bounds stdin, combined output and elapsed time, strips executable
injection environment options, and settles only after actual exit plus fully
drained output and finished input. It does not depend solely on Node's `close`
event. Child JSON remains untrusted: a fresh read-only physical/evidence check
must match it exactly before success. Errors expose bounded codes, not private
source text. Unconfirmed process termination is a failure requiring inspection,
never success or an instruction to restart blindly.

This is still installation of load evidence, not selected-source import. The
actual bounded writer, transaction-owned canonical read, exact catalog/run delta,
signed load result and later-load family composition remain required, together
with complete authority, timeout, hard-death and platform acceptance. No command,
schedule or live installation is activated by adding this API.

Focused launcher evidence: 27 capture/selected-load framing cases passed in
0.887 seconds; the real retained launcher installation/control file passed three
cases in 331.43 seconds. Linked-intent read-only observation and genuine missing
framing refusal passed in 124.72 seconds. The post-canonical-intent interruption
case passed in 87.88 seconds, with independent read-only completion on retry.
These are 33 unique focused cases, not 33 native invocations. Inode/link/permission
and mutation-time observations remained unchanged across read-only checks; access
time is excluded because ordinary reads may update it. Worker/publication types,
lint and formatting passed. Full process termination, hard-death and actual
selected-load execution acceptance remain outstanding.

## Owned canonical catalog transaction, October 28

The selected-source writer must prove freshness inside its own SQLite writer
transaction. `withCanonicalStoreTransaction` now takes a detached authenticated
catalog/generation expectation, refuses any enclosing store transaction, acquires
`BEGIN IMMEDIATE`, pins the database identity, and compares the current catalog
before invoking work. Expected bytes are captured before waiting for the lock;
they are never reread from a mutable caller object afterward. Linked main and
sidecar files refuse before opening. Missing catalogs are not created.

The comparison includes metadata generation/header/digest, all canonical payloads
and positions, normalized event columns, artist links and source rows, exact
schema objects, integrity and foreign-key checks. A payload digest by itself
misses generation-only changes and changes to normalized relations or schema.
Prepared first-load catalogs are initialized by `stageOperatorRecovery` using
`writeSqliteLedger(..., true)`; their initial generation is one. Later load
admissions must derive their generation from authenticated prior-load evidence,
not assume one or silently rebase a signed baseline.

The ordinary transaction entry keeps its existing borrowing behavior. This new
entry is a precondition on an already authorized operation, not a private scope
constructor, quarantine bypass or source-load permit. The selected-source
executor still has to bind it to the installed admission and exact normal runner
invocation. It is not yet wired into a selected-load writer.

Focused SQL evidence: 13 canonical transaction cases plus eight existing read-only
catalog cases passed in 1.37 seconds; 14 shared-store cases passed in 19 seconds.
The cases cover actual lock wait followed by generation-only drift, hidden source/
artist/event/schema changes with an unchanged payload reader result, immutable
expectations, no transaction borrowing, rollback and linked/missing catalogs.
Normal shared-store serialization, portable encrypted recovery and interrupted
transaction recovery remain passing. Worker/publication types, lint and format
are checked separately; no full selected-load acceptance is claimed here.
