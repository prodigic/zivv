# Durable Gmail acquisition handoff (#30)

Implemented same-host acquisition, replay, local loading and freeze contract for
#30. Credentials, supervisor integration and portable batch recovery remain
unfinished. No live ledger or schedule change is authorized by this document. Keep the
manual capture/Friday commands unchanged. Reuse `readSteveGmailWindow`,
`captureSteveEmail`, `listRetainedSteveEmailSources` and the existing production
lease; add one private batch module, not another journal or transaction layer.

## API and identities

`captureSteveGmailWindow({operatorDirectory, expectedAccountId,
expectedEditionId, startEpochMs, endEpochMs, getAccessToken?, fetcher?,
correctionOfByMessageId?})` returns only `{status:'missing'|'captured', replayed,
batchIds, messageCount, receipts:[{receiptId, sourceSha256,
firstObservedAtEpochMs, disposition}]}`. It performs capture, not worker loading.
An explicit `replaySteveGmailBatch({operatorDirectory, batchId,
expectedAccountId, expectedEditionId, correctionOfByMessageId?})` also permits
offline repair/approval of a previously completed batch. A read-only
`readSteveGmailHandoffStatus(...)` reports pending/complete identities and counts,
never opens a journal writer, creates a key, requests a token or repairs files.

Bind account identity to the exact configured `expectedAccountId` string, also
used for capture and retained-source lookup; preserve the provider account string
inside each snapshot and require the reader's case-insensitive profile binding.
This avoids provider lettercase changing receipt namespaces. Operators must use
the same configured spelling as existing manual receipts; do not migrate them.
Validate the dated edition, integer half-open window, unique message IDs,
projected snapshot schema/limits and original internal-date/ID order on read.

`batchId = SHA256(canonicalJson([kind,version,accountSha256,editionId,start,end,
orderedPairsOfMessageIdAndRawSha256]))`. Preserve every complete projected
snapshot and its original observation time in the immutable payload. Unchanged
polls reuse the first durable bytes: require matching snapshot contents except
new poll observation times; refuse changed FULL metadata for an established
same-ID/raw pair. Changed/new messages, corrections or windows produce another
batch; overlapping messages converge through existing receipt IDs. Bind payload
to canonical physical operator path, key ID, batch ID and first durable-save
time; HMAC-SHA256 with domain
`zivv-steve-gmail-batch/v1\0` and the existing backup key (load, never replace).
Signing proves local provenance, not arbitrary uploaded email authenticity.

## Storage, replay and concurrency

Store only `operator/email-acquisition/batches/<batchId>.json`; this directory is
the registry. No completion marker, mutable cursor, journal kind/table/schema or
recovery-format change. Derive capture completeness by matching **every** batch
message to its validated canonical `capture.json`, raw/source hashes and existing
journal-anchored receipt. Reuse the read-only retained-source validator; expose a
narrow message-resolution helper there if needed, including duplicate message
IDs that share one body receipt. Never trust a bare capture.json lookup or a
receipt-ID count. Derive load completeness separately from exact worker evidence.
A missing remote window creates no batch and cannot complete pending local work.

Before token acquisition, authenticate and replay all capture-incomplete batches
for the configured account+edition, across retained windows, then return without
fetching. Capture-complete/load-pending batches do not suppress future polling:
review-required evidence must not prevent discovering later mail. Fetch outside
the lease. After the reader
returns the entire bounded window, acquire the existing production lease and
`guardOperation`, recheck pending work, and exclusively install/flush the whole
found batch **before any capture**. Preserve a newly fetched result even if
another batch became pending during HTTP; then replay pending batches in durable
save-time/ID order. Release that lease before sequential `captureSteveEmail`
calls, since capture acquires its own lease. Re-read canonical receipt evidence
after all captures; report complete only when every message resolves. An
existing identical-content batch adopts its first bytes; conflicting valid
contents, unsafe paths or invalid signatures refuse before capture/fresh fetch.

Keep the reader's 100-message/32 MiB serialized-snapshot bound; allow 64 KiB
additional batch metadata. Existing
`readRecoveryInstalledFile` caps at 16 MiB, so do not widen it or silently reduce
accepted windows. Use a dedicated bounded batch reader and the existing
`writeDurableFile` plus exclusive-link installation pattern: private ACLs,
canonical local paths outside Git, no symlinks, checked regular-file inode/link
identity, file/parent flush where supported and exact readback. A writable replay
may adopt a unique complete authenticated staging orphan or remove only its
proven installation alias. Preserve partial/ambiguous staging files and report
pending/refusal; never discard them or silently fetch around them. Read-only
status treats such files as pending and does no alias cleanup.

The retained registry and staging together are capped at 1,000 entries and
256 MiB of serialized files, checked before JSON parsing. Installation reserves
space for its temporary hard-link alias conservatively. Exceeding a bound returns
`GMAIL_BATCH_RETENTION_LIMIT`; it never deletes evidence or reduces the accepted
per-window size. Operator-assisted archival/retention remains part of #106.

## Admission, freeze and tests

No batch timestamp substitutes for `firstObservedAtEpochMs`: intake establishes
it at first committed receipt admission. Monday replay repairs an already
admitted receipt, but a still-uncaptured message gets
`SOURCE_WINDOW_REQUIRES_REVIEW`; retain its batch. Stop on capture failure,
derive capture-incomplete and replay the whole batch later without HTTP, including
after mailbox deletion. Existing capture repairs journal-before-file failures.
Reject unknown mapping keys; pass only explicitly selected `messageId ->
correctionOf` values to capture. No newest-message approval or inferred parent.
Capture-complete cached batches can be explicitly replayed with an approved mapping;
the existing correction journal remains the only approval authority.

The freeze pending gate runs under its existing lease: every message in
a batch first saved before cutoff requires a validated receipt and exact
successful same-delivery load (source hash and first-observed time), **even when
receipt first-observed time is at/after cutoff**. Review-required is never approval.
Keep existing weekly semantics and receipt/source-file checks. Authenticated
batches/stages after cutoff are excluded from this added temporal gate; malformed
or partial staging with no authenticatable time fails closed rather than being
silently classified as post-cutoff. An absent/empty batch area adds no key
requirement to the manual path. Read-only partial-capture status does not repair;
writable cached replay does. This closes the local acquired-before-freeze gap,
not the unavoidable crash interval before any complete remote result is saved.

## Recovery boundary still requiring implementation

The current operator recovery inventory rejects the new `email-acquisition`
tree with `UNCLASSIFIED_OPERATOR_ARTIFACT`. It does not silently omit the batches.
Do not delete retained batches to make recovery capture succeed. Issue #106
tracks authenticated inventory, successor-host admission and preservation of
pre-cutoff capture/load obligations. Batch signatures bind the original physical
operator directory; copying them to another host does not grant replay authority.
This gap must be resolved before unattended acquisition/recovery acceptance.
The [batch recovery plan](gmail-batch-recovery-plan.md) separates authenticated
inventory/read support from the closed capture (#109) and selected-source load
(#110) admissions; a pure proof result grants none of those permissions.

## Verification and remaining acceptance

Luna medium implemented the batch, resolver and local load seams and initial
tests. Sol high reviewed authority boundaries and identified source-binding,
late-arrival and aggregate-size gaps; root integrated the fixes and whole-path
tests. No measured token or monetary savings are claimed.

Tests exercise fake paginated API acquisition, duplicate IDs sharing one source,
stable real SQLite loads, cache-only repair, explicit correction approval through
the actual freeze stage, late pending/orphan installation, exact source binding,
partial/tampered/linked evidence and bounded storage. Acquisition/projection and
the existing intake tests remain the separate account/MIME/clock boundaries.

Full #30/#38 acceptance still requires credential setup, the installed supervisor,
broader process-kill/journal-before-file/missing-mailbox drills and #106 recovery
portability. The manual commands remain supported; no test activates a schedule,
publishes a candidate or sends a notification.
