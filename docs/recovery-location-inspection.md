# Inspecting restored recovery locations

This is the read-only location/report step of
[#78](https://github.com/prodigic/zivv/issues/78), following the
[encrypted operator capsule](operator-recovery.md). It does not admit an
installation, resume a worker or authorize effects. Normal manual installations
keep their existing paths and checks.

After staging a capsule into a new private directory, run:

```text
npm run operator:recovery -- inspect --file PRIVATE_CAPSULE --key PRIVATE_PORTABLE_KEY_FILE --destination EXISTING_STAGING_ROOT
```

The command authenticates the encrypted capsule itself; an editable staging
marker cannot substitute for it. The portable key is read from the separately
stored canonical base64 key file. It is never installed into staging. The command
does not acquire ownership, change a database, write a report or contact a remote
publisher. Save its standard output privately outside staging and Git if a
retained report is needed.

## Verified evidence

Inspection checks the staged marker against the authenticated checkpoint, exact
retained file hashes and explicit absences, complete file/directory inventory,
and the restored catalog and journal rows. Catalog metadata, primary payloads,
event query columns, artist/source rows and restored generation are compared;
journal run/artifact/admission rows and ownership counters must match, with only
the staging protocol's expiry clearing allowed. Unexpected files, directories,
links, hard links, WAL/SHM sidecars or changed evidence stop inspection.

SQLite is opened with an immutable read URI because a normal read-only WAL
connection can create sidecar files. Immutable mode disables normal locking and
must never inspect an active database. This command requires sidecar-free
quarantined staging and verifies main-file hashes before and after logical reads.
The context also rejects later changes before any subsequent lookup.
SQLite documents these locking and change-detection limits in its
[immutable URI reference](https://www.sqlite.org/uri.html#uriimmutable).

The underlying `inspectOperatorRecoveryLocations` interface returns:

- A detached report containing checkpoint/catalog identities, counts and runtime
  comparisons, with `status: "inspected"` and `activationAllowed: false`.
- `readOriginalFile`, which reads only exact authenticated inventory entries
  through their original absolute names; it never falls back to surviving old
  files or exposes physical databases as retained files.
- `resolveOriginalDirectory`, with explicit roles for `export.workDirectory`,
  `capture.directory` and `capture.sourceRoot`. The current generator's
  `candidate-work-*` / `source-build-*` / `source` layouts and retained capture
  receipt bindings must agree. Arbitrary directory-role substitution is refused.

Original operator/checkout roots must be absolute, disjoint and separate from the
new staging root. Every lookup revalidates the complete offline inventory and
database baseline. The original receipt strings, bytes and hashes remain intact;
resolution supplies a physical location without editing them. This frozen
inspection context is not an active-worker filesystem adapter.

The existing capsule limits apply: 256 MiB cleartext and 50,000 files/directories.
Inspection additionally caps each SQLite main file at 512 MiB and the staging
marker at 2 MiB. Retained files are bounded by their authenticated byte counts.

## Runtime and checkpoint classes

The report compares the inspecting executor's Node version, ICU, Node executable,
compiled worker and lockfile against the recorded runtime. A mismatch remains
visible rather than granting compatibility. Legacy captured builds do not retain
the npm package identity, so `npmIdentity` is `not-retained`. New schema 2 builds
retain [private execution-tool provenance](build-execution-tool-identity.md), and
inspection reports `retained-build-identities` when this evidence is present.
Explicit v2 captures additionally retain a bootstrap npm profile before a build;
inspection reports `retained-bootstrap-identity` for these checkpoints. The
separate [runtime preparation command](recovery-runtime-preparation.md) verifies
the physical tool and installs/probes production dependencies in quarantine.
This does not verify a replacement installation or imply coverage of every run. Successful
decryption proves possession of the capsule key, not installation of a working
operator key or approval of a replacement execution tool.

| Checkpoint                      | Evidence inspected here                                           | Required before runnable recovery                                                               |
| ------------------------------- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Before load                     | Catalog, journal, raw source and retained reports/configuration   | Admitted executor/configuration, fresh writer ownership and fencing                             |
| Frozen/enriched/validated       | Retained candidate/source inventory and typed directory locations | Consumer integration, compatible execution-tool binding and remaining-build source provisioning |
| Pending dispatch                | Candidate and private claim/dispatch evidence inventory           | Real authoritative Git checkout, exact workflow ancestry and canonical remote reconciliation    |
| Verified before acknowledgement | Retained candidate, journal and weekly configuration              | Admitted physical store/weekly locations, historical verification and completion reconciliation |

This table describes the inspection seam. It does not claim four successful
fresh-environment resumes. Interrupted/unacknowledged candidate exports retain
their existing rebuild requirement.

## Remaining admission work

The report always lists reviewed executor binding, execution-tool binding,
working-key installation, authoritative Git checkout, old-installation fencing, remote ownership
reconciliation and fresh-environment drills as requirements. Adding resolver code
changes the worker inventory included in historical run identity; do not bypass
`RUN_CONTEXT_CHANGED` or rewrite hashed build options to relocate an npm path.

The staging marker and existing worker/intake/capture quarantine checks remain in
place. Inspection does not remove the marker or turn it into activation authority.
It also does not fence another machine, select off-machine storage, install a
scheduler, or recover private state newer than the capsule. Those acceptance
items remain open in #78, #79 and the
[Friday plan](friday-delivery-plan.md).

## Verification evidence

The local batch passed 26 location/CLI cases and 18 maintained capsule cases.
After the final cross-database hash refinement and rebuild, all 26 location/CLI
cases passed again. Tests use actual encrypted capsules and restored SQLite
stores, including a real synthetic import populating every catalog table. They
prove no changed database/evidence bytes or WAL/SHM sidecars, unchanged ownership,
post-inspection drift refusal, role separation, capture receipt binding,
link/traversal/ambiguous-root rejection, wrong-key/forged-marker refusal, and
bounded CLI output without private paths or source/key content. Altering an
indexed event date is rejected even when the payload-based ledger digest agrees.

Strict TypeScript, repository lint/source formatting, production Vite build and
compiled ETL passed. Sol-high review checked the offline authority/read-only
contract. Full exact-head CI independently verifies the complete suite; none of
this evidence constitutes an installation admission or operational recovery drill.
