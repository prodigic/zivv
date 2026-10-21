# Private Steve's List Gmail intake

This stage captures an authenticated Gmail message into private, durable evidence
and optionally hands its exact plain-text bytes to the weekly import worker.
Capture alone neither imports nor publishes. The manual source-file route remains
available. Scheduling and unattended Gmail credentials are separate installation
steps; a Node process does not inherit the agent's Gmail connector access.

## Acquisition contract

The operator bridge must obtain the account identity, raw message and full message
from the authenticated Gmail connector for the same message ID. Transfer those
results programmatically into a private JSON snapshot, without copying message
content through model output, shell arguments, Git or logs:

```text
{
  accountId: authenticatedProfile.email,
  rawMessage: { id, raw },
  fullMessage: { id, internal_date, payload },
  observedAtEpochMs: bridgeObservationTime
}
```

The payload uses the connector's `mime_type`, `filename`, `parts` and `body`
fields. Keep the inline plain-text body's declared `size` and either its
`base64_url_content` or decoded `content`. If both forms exist, they must agree.
The declared byte count and text parsed independently from the raw MIME message
must agree too. HTML and attachments cannot substitute for the plain-text source.
The original RFC 2822 message and decoded source bytes are retained privately.

An uploaded JSON/EML file is not authenticated simply because it contains Gmail
headers. This CLI is a trusted local operator interface, not an upload endpoint.
Its receiver profile assumes the controlled account-bound Gmail acquisition path.
[Gmail's message reference](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages)
defines raw/full representations and notes that imported messages can have a
caller-selected internal date. Accordingly, local admission time, Gmail receipt
time and sender date are retained separately.

The versioned `steve-gmail-eocampaign-v1` profile pins the confirmed sender
`skoepke@stevelist.com`, the observed `sp.eocampaign1.com` bulk-mail sender and
Gmail receiver results. Duplicate or ambiguous security headers, changed sender
identities, failed authentication and conflicting MIME projections stop intake.
DKIM and SPF must pass for the observed provider identity; actual DKIM signing
domains are retained separately. Explicit DMARC failure stops intake; absent
DMARC stays absent. This provider hostname is an observed source-specific pin,
not a claim that every EmailOctopus account uses it.

[EmailOctopus describes sender/domain verification](https://help.emailoctopus.com/article/342-difference-between-email-verification-and-domain-verification),
but [DKIM](https://www.rfc-editor.org/rfc/rfc6376.html) does not independently prove
the displayed author's identity. [Authentication-Results](https://www.rfc-editor.org/rfc/rfc8601.html)
also depends on the trusted receiver boundary. Keep both the authenticated
acquisition path and the narrow receiver profile; review profile drift explicitly.
MIME decoding uses pinned `postal-mime@4.0.7` with resource limits.

## Commands and timing

Use a permanent, private operator directory outside Git and cloud-sync folders.
On Windows keep its absolute path short: account/body evidence adds several
directories containing 64-character identities, and Windows ACL APIs can fail on
long paths. Permission failure stops capture and can be retried after repairing
the installation; do not bypass the directory protection.

```text
npm run weekly:capture-email -- --file PRIVATE_SNAPSHOT --operator-dir PRIVATE_OPERATOR_DIR --expected-edition 2026-10-16
```

Capture defaults to evidence only. An explicit `--root CHECKOUT --through load`
continues through acquire/prepare/reconcile/load using the same receipt. The
checkout must select the same SQLite operator directory. The supported earlier
stops are `acquire`, `prepare` and `reconcile`. No capture flag deploys a release.

The dated plain-text edition header must identify exactly the requested Friday.
Early acquisition/preparation is allowed. New local admission at or after Monday
midnight in America/Los_Angeles is rejected for review; Gmail's older receipt date
or a backdated bridge hint cannot move that boundary. Publication's separate
Friday opening gate remains in force.

## Duplicates, corrections and crash recovery

The receipt identifies account + Friday edition + exact source digest. A duplicate
delivery reuses the original source identity and first local admission time.
Changed raw bytes for an existing Gmail message ID are rejected. A different body
for the same edition requires review; an explicit `--correction-of RECEIPT_ID`
records a linear correction relationship. Competing correction branches stop.
Approving a quarantined revision adds immutable approval evidence rather than
rewriting its original receipt.

The weekly journal schema advances additively to v3. Its immutable, hashed
`intake_evidence` rows commit admission before filesystem effects, under the
production lease. A crash can leave a database admission without its files; retry
the same snapshot to restore the original receipt and timestamp. Changed files,
missing ancestor proof or a changed journal hash stop validation. Schema 1/2
migration preserves existing run state, ownership and stage artifacts.

Before edition freeze, every admitted source within the cutoff must have a
matching successful load with the original source digest, delivery identity and
observation time. Unloaded, quarantined or damaged evidence blocks freeze. A
retry after the source is resolved can continue the same freeze run. Intake and
freeze use the same lease so they cannot race past this check.

Back up the private journal together with its email evidence and other operator
artifacts. The encrypted catalog snapshot alone does not recover this state;
the portable recovery capsule remains a separate work item. Do not delete an
admitted receipt to bypass a blocked freeze.

## Verification boundary

The October 16, 2026 inbox message was captured twice into disposable private
storage. Both attempts produced the same receipt, source digest and original
local observation time; capture-only produced no worker run. Synthetic tests
exercise authentication ambiguity, MIME forms, corrections, cutoff boundaries,
lease contention, schema migration and interrupted evidence writes. This is
implementation/rehearsal evidence, not activation of a Friday schedule.

## Read retained intake without fetching the mailbox

`listRetainedSteveEmailSources({ operatorDirectory, accountId, expectedEditionId })` returns detached `{ receipt, source }` entries from already admitted private evidence. Supply the same account identity used by capture; this preserves existing receipt hashes. The lookup resolves existing correction approval evidence and validates source, original raw message and duplicate-message manifests against the registered receipt. It does not choose a correction parent, approve a source, load an edition or fetch Gmail.

The implementation uses the existing read-only journal recovery snapshot and existing receipt validators. It creates no journal, acquires no writer lease and performs no migration. A missing pristine store returns an empty list; orphan bodies, partial evidence, linked paths, modified data or SQLite sidecars without their main journal refuse. SQLite itself may create its exact WAL/SHM coordination files during a read; tests preserve the main database bytes/mtime, logical rows and every other intake file rather than hiding this behavior with a priming read.

Seventy-two synthetic tests passed: ten retained-lookup cases and the existing 62 intake regressions. Coverage includes two different Gmail IDs sharing the same immutable source receipt, explicit correction approval, tampering, missing evidence and unchanged first-observed time. This supplies a recovery seam for the future acquisition/supervisor integration; it is not an unattended runner or a completed Friday acceptance rehearsal.

## Durable acquisition and local loading

The [durable Gmail handoff contract](steve-gmail-durable-handoff.md) connects the
account-bound API reader to immutable private batches before intake begins.
`captureSteveGmailWindow` replays capture-incomplete batches before requesting a
token. `replaySteveGmailBatch` supports offline repair and explicit correction
selection; `readSteveGmailHandoffStatus` derives capture/load status from retained
evidence rather than a mutable completion flag. A completed capture does not
suppress discovery of later mail.

`loadRetainedSteveEmailSources({ root, operatorDirectory, accountId,
expectedEditionId })` uses the existing worker through `load` for ready receipts,
preserving their source, delivery identity and first local observation. It
withholds review-required bodies and stops processing later ready receipts after
a worker failure. The checkout must select the same physical SQLite operator
store. Its report contains counts and receipt/run identities, never message
bodies or account addresses. It does not freeze or publish.

Freeze additionally requires exact successful loads for batches saved before its
cutoff, including receipts admitted after that cutoff. Batch evidence remains
private. Portable batch recovery is still unsupported under #106; the existing
recovery inventory refuses the new acquisition tree before archive output or
retirement. Credentials, supervisor installation, schedule activation and full
Friday rehearsals remain separate work.
