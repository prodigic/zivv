# Shared ledger and encrypted recovery

## Use the authoritative store

All checkouts with `data/ingestion/store.json` use the same SQLite database on
this computer. On Windows it lives under `%LOCALAPPDATA%\Zivv\ingestion`;
on other platforms it lives under `~/.local/state/Zivv/ingestion`.
`ZIVV_LEDGER_HOME` explicitly selects another local operator directory for tests
or a separate installation. Keep the live store on a local disk outside Git
worktrees and cloud synchronization folders.

Use Node 24.19.0 or newer. The adapter also checks the SQLite library version
and requires 3.51.3 or newer. It uses WAL, FULL synchronization, foreign keys,
and a transaction around each import or repair. Readers see a complete committed
revision. Writer locks belong to SQLite and disappear if the writer crashes.
Writers wait up to 30 seconds for a busy store.

Before importing from another chat, update that checkout to include the shared
store implementation and run `npm run ledger:status`. Older checkout code still
uses its private JSON file; it must be updated before running imports or publishing.
The current ignored workspace JSON is retained as migration evidence and is no
longer authoritative. A missing shared database fails explicitly instead of falling
back to that older copy.

The persistence adapter preserves the existing reconciliation rules. It stores
individual event, artist, venue, receipt and redirect rows, and writes changed
rows transactionally. Matching still runs through the existing in-memory
reconciler; the source identity and event indexes provide a seam for future
incremental queries. Stable IDs, first-added dates and all provenance survive
migration unchanged. A standalone save of an outdated loaded revision is rejected.
Source disagreements remain subject to the existing matching and review rules;
database transactions do not decide which source is correct.

## Migrate an existing private ledger

```text
npm run ledger:migrate
npm run ledger:export-key
npm run ledger:verify
```

Migration validates the existing workspace ledger, verifies restoration into a
temporary database, creates its encrypted snapshot, then initializes the permanent
database. Repeating migration requires an identical catalog and cannot replace a
newer shared store. Use `--source PATH` to explicitly select the source ledger.

Every successful shared import, repair, weekly operation and ETL export refreshes
that checkout's encrypted snapshot. The snapshot also refreshes before an operation,
closing the backup gap left if a prior process exited immediately after committing.
If the post-commit backup fails, the database remains committed and the command
reports failure; repeat the operation or run `ledger:backup` to refresh the snapshot.
Import receipts make retries safe. Existing snapshots with identical content keep
their bytes, avoiding meaningless Git changes from fresh encryption nonces.

## Back up and publish

```text
npm run ledger:backup
npm run ledger:verify
```

`data/ingestion/backups/ledger.snapshot.enc` is the complete logical ledger,
compressed and encrypted with AES-256-GCM. The authenticated envelope records
its format, cipher, compression and key identity. The encrypted contents include
the ledger schema, content checksum, original IDs/dates, source observations,
conflicts, import receipts, migration metadata and redirects. Keys and clear
snapshots stay outside Git. Weekly editions and other reviewed configuration files
remain separately versioned in the repo.

Backup reads one committed database revision, decrypts its new output to validate
it, and flushes a temporary encrypted file before replacing the repo snapshot.
Explicit `ledger:backup` and `ledger:verify` also rebuild a temporary SQLite database
and run database integrity and foreign-key checks. Backups use the existing key;
an unreadable existing snapshot fails instead of being silently replaced.

Before publishing generated data, refresh the encrypted snapshot from the shared
database and stage it alongside the validated public export. After a Git conflict
on the encrypted snapshot, regenerate it with `ledger:backup`; Git cannot combine
encrypted files. Use the authoritative database revision to resolve the conflict.
Git history holds earlier snapshots. GitHub Actions builds the checked-in public
JSON and runs synthetic ingestion tests; it has no decryption key and does not
restore the operator's private catalog. Encrypted backups live outside `public/`.

## Preserve the recovery key

On Windows, the working key is protected for the current user with DPAPI. Its
directory permits access only to that user. Other platforms use a private key
file with restrictive filesystem permissions. The portable recovery export is
`recovery/backup-recovery.key` under the operator directory by default. An export
inside a Git checkout is rejected, and the command never prints the key.

Copy the recovery key into a password manager or onto a separate secure device.
The encrypted repo snapshot alone cannot recover the database after losing the
computer and its key. `ledger:export-key -- --file PATH` writes to an explicitly
selected private destination. Keep the working key and recovery key out of Git.

## Recover a new installation

Check out the desired Git revision containing the encrypted snapshot, then:

```text
npm run ledger:import-key -- --file /private/path/backup-recovery.key
npm run ledger:verify
npm run ledger:restore
npm run ledger:status
```

Restore authenticates and validates the snapshot, restores it into a fresh staging
database, and verifies its exact logical content before installing it. For an
existing database, `ledger:restore` requires `--expected-revision SHA256` from
`ledger:status`. It rechecks that digest while holding the writer transaction,
saves an encrypted rollback copy privately, then replaces the catalog in one
transaction. A concurrent edit invalidates the expected revision and aborts.
Restoring an older Git snapshot is an explicit rollback, not a ledger merge.

## Verification

The shared-store suite covers exact migration, two workspaces, stale writes,
transaction rollback, simultaneous updates, cross-process locking and process
termination. Encryption checks cover exact recovery, wrong keys, modified
ciphertext and format headers, and fresh nonces. The command-line recovery checks
exercise backup reuse, portable-key recovery and guarded rollback. ETL still emits
static JSON for the browser.
