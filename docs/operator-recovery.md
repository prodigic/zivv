# Private operator recovery checkpoint

The encrypted catalog snapshot remains useful, but does not include the Friday
worker journal, raw email evidence, candidate files or dispatch intentions. This
checkpoint captures those together. It restores into a new offline staging root;
it does not replace an installation, restore an old catalog over newer writes,
roll back a public release, enable scheduling or acknowledge a weekly cutoff.

## Capture and verify

Use the maintained runtime and the authoritative SQLite installation described in
[shared-ledger.md](shared-ledger.md). Keep the permanent operator path short on
Windows so nested evidence paths fit the native ACL APIs. The existing separately
exported portable recovery key is required on another machine. The user-bound
Windows DPAPI working key is deliberately excluded from a capsule.

```text
npm run operator:recovery -- capture --root CHECKOUT --out PRIVATE_CAPSULE.enc
npm run operator:recovery -- verify --file PRIVATE_CAPSULE.enc --key PRIVATE_PORTABLE_KEY
npm run operator:recovery -- stage --file PRIVATE_CAPSULE.enc --key PRIVATE_PORTABLE_KEY --destination NEW_PRIVATE_STAGING_ROOT
```

Capture uses the installation's existing working key, without generating a
replacement. Output must be a new private file outside Git. Verify/stage use the
existing portable base64 key file. Key and capsule input files must be regular,
unlinked files within the size limits. CLI diagnostics contain only bounded
codes and public-safe counts/revision; never email or upload the private evidence
as part of a support log. Keep the portable key separately from off-machine
capsule storage.

## Coordinated contents

Capture obtains the production journal lease, then the journal operation guard,
then the catalog transaction, following the worker's established lock order.
Catalog and journal are exported logically from their transactions rather than
copying a live SQLite file independently of its WAL. A second exact filesystem
inventory detects ordinary file/configuration drift before capture finishes.

The capsule retains:

- Validated catalog content and its revision digest.
- Journal ownership counters, exact canonical run payloads, every stage/attempt
  artifact and schema-v3 intake/correction evidence, with original hashes.
- `email-intake`, `weekly-candidates`, `weekly-publication` and `rollback` trees,
  including empty attempt directories, source MIME/text, receipts, claim plans,
  dispatch records, candidate snapshots/configuration and public files.
- Checkout import reports; the complete export configuration and import policy
  files, including historical-batches/migration and explicit absence; store
  configuration, package/lockfile and compiled worker lib/types/utils trees.
- Original checkout/operator paths, Node/ICU versions, executable hash, compiled
  worker inventory digest and lockfile digest.

Working keys and `recovery/backup-recovery.key` are never embedded. Dependency
and npm cache trees are omitted; exact locked dependencies need reinstalling in
the reviewed runtime. Unknown operator-root artifacts or unknown contents in the
designated recovery-key directory stop capture for classification. Arbitrary
standalone review directories outside these roots are not silently treated as
recoverable worker state: referenced external work directories stop validation.

Every admitted source needs its retained raw MIME, text and exact receipt;
correction approval files must match journal evidence. Successful loads need the
original report digest, not merely a report filename. Successful exports need
one matching completed candidate with its sealed inventory, ledger, paired
snapshot, build and configuration. Encryption/decryption reauthenticate the seal
using the supplied key. Missing evidence stops recovery rather than being omitted.

The distinct versioned format authenticates its header and whole compressed
payload with AES-256-GCM and a fresh random nonce. Decode authenticates before
bounded decompression and validates schemas, canonical journal evidence, safe
relative paths, case collisions, checksums and references. Clear checkpoint size
is limited to 256 MiB, with at most 50,000 files and 50,000 directories. Larger
installations need an explicitly designed streaming format rather than raising
limits casually.

## Offline staging and remaining cutover work

Destination must not exist and must be private/local/outside Git. A failed
restore leaves an `incomplete` marker; inspect/preserve that staging and choose a
new destination for retry. A successful restore leaves:

```text
NEW_PRIVATE_STAGING_ROOT/
  operator/          # rebuilt SQLite stores and exact retained evidence
  checkout/          # configuration, reports and compiled worker inventory
  recovery-state.json
```

The journal restore is atomic and refuses nonempty tables. It preserves fence
counters and immutable evidence, while clearing ownership expiry so recovery
must acquire fresh ownership. That does not fence an old installation on another
machine. After installation, file hashes, catalog revision and compiled worker
inventory are checked again. No working key is installed automatically.

The staging marker grants no activation permission. Weekly import, email intake
and checkpoint capture reject operator directories beside any such marker, even
if its JSON claims activation. Other manual library/repair interfaces are not
sandboxed by this marker. Do not point production tools at staging or remove the
marker to bypass cutover review.

Absolute paths inside immutable source/build/export artifacts remain unchanged.
The optional [location inspection command](recovery-location-inspection.md)
authenticates and verifies their staged inventory without changing receipt bytes
or granting activation. It reports runtime mismatches and missing tool admission.
Restoring bytes at a different location does not establish compatible runtime or
path bindings. A validated relocation resolver and exact-runtime resume rehearsal
remain required before operational restoration. Do not edit hashed receipts or
substitute a newer compiler/runtime to bypass `RUN_CONTEXT_CHANGED`.

Before activation, separately prove compatible paths/runtime and candidate/browser
recovery, fence the old installation, install the separately saved portable key,
and reconcile canonical remote control/history, retained public artifacts and
dispatch intentions. Never reset remote authority to the capsule's older state.
A local capsule can predate a dispatched effect; missing or uncertain dispatch
proof must stop publication. A complete machine-loss guarantee also requires
off-machine durability of new effect intentions before those effects occur.
These are remaining acceptance work in [#36](https://github.com/prodigic/zivv/issues/36)
and [#38](https://github.com/prodigic/zivv/issues/38), not completed by staging.

The existing [manual Friday path](journaled-weekly-import.md#run-and-resume)
continues to work in the normal installation. This optional checkpoint installs
no scheduler and changes no live catalog, publisher flags, production ref or key.
