# Exact publication payload

Checkpoint for [#35](https://github.com/prodigic/zivv/issues/35) and
[#36](https://github.com/prodigic/zivv/issues/36), stacked after journaled
candidate validation. This implements the immutable handoff to a future
deployment controller. It does not deploy, acknowledge an edition, or activate
Friday automation.

## Boundary

The private candidate reader first checks the trusted candidate identity,
nominated source commit, purpose and base, including authenticated recovery and
the captured application build. The payload contains only its checked bytes:

```text
receipt.json                 public-safe candidate/build provenance and hashes
site/                        exact validated public files
recovery/ledger.snapshot.enc  matching authenticated encrypted ledger snapshot
```

The receipt includes the exact build manifest and build receipt as base64. Those
bytes must match the candidate's build/provenance digests. Build purpose is
verified against that receipt; changing a preview label cannot authorize a
production release. Configuration contents, clear sources, ledger, journal,
operator paths, reports and keys are excluded.

The payload verifier requires a candidate ID obtained independently from the
trusted run receipt. A checksum taken from the payload itself is insufficient.
It recomputes candidate identity and checks the complete file inventory,
snapshot hash, application provenance and expected source/base/purpose. It
does not decrypt recovery material; authenticated validation happens in the
private preparation step. Directory reading rejects linked files/directories
and unexpected material.

## Immutable Git storage

Raw Git objects preserve bytes without checkout attributes, line-ending
conversion or filters. Each standalone commit uses a supplied, persisted
timestamp and fixed author, so repeating the same preparation produces the
same object identity. No ordinary index, worktree, HEAD or reference changes.
Raw object reading uses the exact full commit SHA, rejects unsupported object
modes and verifies the bytes independently of replacement references.

The writer permits only the authoritative `prodigic/zivv` origin. Encrypted
recovery must never be placed in the public `prodigic/zivv-test` repository.
Future remote transport must retain payloads on a non-served artifact branch;
only `site/` may enter a Pages upload. The local preparation command creates
unreferenced objects, which are not yet durable remote storage and can be
garbage-collected. Record its returned identity and retain the private candidate
until the remote transport checkpoint succeeds.

## Operator commands

Compile the ingestion code with `npm run build:etl`. Prepare from a completed
candidate, using the original trusted ID and source commit, and the existing
operator key:

```powershell
node scripts/prepare-publication-payload.js prepare `
  --directory '<private candidate directory>' `
  --operator-dir '<permanent private operator directory>' `
  --candidate-id '<trusted 64-character candidate ID>' `
  --source-commit '<reviewed 40-character source commit>' `
  --purpose release --base /zivv/ `
  --created-at '<persisted canonical UTC ISO timestamp>'
```

The command re-reads the Git payload and verifies it before printing public-safe
identities. Reverify without loading a key or rebuilding:

```powershell
node scripts/prepare-publication-payload.js verify `
  --payload-commit '<exact payload commit SHA>' `
  --candidate-id '<trusted candidate ID>' `
  --source-commit '<reviewed source commit>' `
  --purpose release --base /zivv/
```

Routing-preview preparation uses `--purpose preview --base /zivv-test/`, still
stores its encrypted pair only in the source repository, and has a distinct
identity. Exact release rehearsal serves `/zivv/` candidate bytes at another
origin without rewriting or rebuilding them.

## Verification

GPT-6.1 Sol high handled two bounded implementation lanes: 38 payload tests
and 42 raw Git tests. A separate Sol high read-only audit found no actionable
defects in this checkpoint. The identity parser adds 13 malformed/rehashed
identity cases. Tests exercise actual encrypted private bundles, raw Git,
the preparation/verification CLI, purpose spoofing, altered public/snapshot
bytes, extra private files, links/junctions, unsafe paths and Git modes,
replacement objects, inherited configuration and ordinary checkout preservation.

The real Git integration cases use bounded case-specific limits where Windows
process startup exceeds Vitest's five-second default under concurrent load.
Assertions, production lease behavior and fatal error handling are unchanged.

A disposable full-catalog rehearsal used the actual journaled-import and
payload CLIs. It advanced 4,641 events to 4,642 with one synthetic show,
completed eight stages, prepared and reverified all 55 public files, and
resumed without another import or build. Existing IDs, slugs and first-added
dates and the production ledger digest remained unchanged. It finished in
130.418 seconds. Its temporary candidate, objects and key were cleaned up;
no public payload was pushed or deployed.

The final ingestion regression gate passed all 56 files: 656 tests passed,
one skipped, exit code 0, in 350.26 seconds. Strict application, ingestion and
changed-test TypeScript, repository lint, formatting, production Vite build
and diff checks passed. Earlier concurrent runs exposed three five-second
integration timeouts; their real Git/build cases now have scoped 30-second
limits and passed the final full run. No assertion or production behavior was
relaxed.

## Remaining delivery work

The journaled worker still stops at validation. Remote artifact retention,
durable promotion ownership, dispatch, deployment receipts, live verification,
acknowledgement and public rollback are subsequent work. A local payload commit
is not publication success. Before activation, the maintained manual deploy
path must join the same remote promotion controller.

The first controlled production release also needs retained, live-verified
rollback bytes from the existing site. Record legacy public bytes as a distinct
bootstrap snapshot; do not invent a candidate ID or authenticated ledger pair
for them. Promotion ownership must remain held through uncertain dispatch,
deployment, verification and acknowledgement or rollback. A stale request
cannot reparent itself onto a newer control head.

Full fresh-host recovery must include the journal, raw/prepared evidence,
reports, frozen/configuration state and candidate material, with portable
private directory/runtime references. The encrypted ledger snapshot alone is
insufficient. Source acquisition, runtime, alerts, metadata queue and two
observed Friday runs also remain on the approved plan.

The existing manual Friday import/export/publication path is available at this
checkpoint. No production source, catalog, cutoff, Pages setting, credential or
schedule is changed by these commands.
