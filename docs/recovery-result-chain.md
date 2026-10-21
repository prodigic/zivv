# Authenticated frozen-result handoff

Tracking: #78 and #38. This work follows verified-before-acknowledgement recovery.
The first implementation unit is a private container and captured-state proof.
It does not authorize recapture, retirement, preparation, dispatch or activation.
Those effect-bearing coordinators and their native acceptance remain required.

## One explicit transition

```text
original frozen capsule and retirement
  -> prepared quarantined runtime
  -> actual same-run validated candidate
  -> authenticated resulting checkpoint and intermediate retirement
  -> separately prepared replacement host
  -> same-candidate dispatch under fresh canonical authority
```

The handoff retains seven exact members: original archive, original retirement
receipt, original preparation receipt, frozen admission, validated result,
successor archive and successor retirement receipt. The new container is
encrypted and has a domain-separated certificate. Both ordinary archive/receipt
pairs remain independently verifiable. Original stage receipts and paths are
preserved; a signed export role supplies physical relocation rather than editing
historical evidence. The first format permits exactly one edge, without nested
containers or arbitrary chain depth.

Captured-state proof must derive its fields from authenticated members and actual
sealed bundle contents. It preserves the original run/source, first five stage
rows and artifacts, ledger revision, frozen weekly bytes and configuration. It
requires a resulting first-eight-stage success prefix with deployment,
verification and acknowledgement pending. Signed but inconsistent members,
unexplained output, partial builds or mixed identities must be refused.
The initial format covers a clean first attempt at enrichment, export and
validation with one retained source-build recipe. A successful result following
failed build attempts requires additional chain support and remains part of the
interrupted-build work; it is not silently accepted by this first format.

The library exposes `proveRecoveryResultChain`, `encryptRecoveryResultChain` and
`decryptRecoveryResultChain`. Fixed binary frames carry raw members under
authenticated encryption, with a bounded canonical JSON certificate. The member
aggregate allows two existing standard archive maxima plus five 64 KiB metadata
members; the certificate is separately bounded to 64 KiB. Authentication precedes
bounded gzip expansion. This is an in-memory format; maximum-size memory use has
not been benchmarked. It introduces no CLI or operational effect by itself.

## Proof boundaries

Standard capsules omit installed bootstrap dependencies and root-level preparation
metadata. A format parser can authenticate the signed physical commitments but
cannot reconstruct that omitted physical inventory or establish fresh remote
heads. Its detached proof therefore requires physical and fresh canonical
validation, and always carries `activationAllowed: false`.

The [recapture coordinator](recovery-result-recapture.md) verifies the bounded result under the
existing journal/catalog locks. Ordinary capture of quarantined state remains
forbidden. A narrowly minted internal capture capability must grant no weekly
runner authority. Persist the exact encrypted handoff plan durably before fencing
the intermediate installation; after fencing, retries repair outputs from those
exact planned bytes rather than recapturing or removing the fence.

New-host preparation and admission must separately authenticate this chain,
provision the exact runtime, map only its signed export role and recheck fresh
canonical authority. They must retain the original request/candidate/attempt
identity and the existing lost-response reconciliation rules.

## Durable plan and retired-source observation

`recovery-result-plan.ts` stores an authenticated plan containing the exact
encrypted chain bytes before a future coordinator may retire the intermediate
installation. The plan binds its physical root, operator, repository, npm CLI,
output, run and original receipt hashes. Its portable output receipt omits the
physical output path. Exclusive installation, authenticated orphan-stage recovery
and byte-identical output repair preserve the same chain on retries. The storage
primitive requires a caller-supplied fence assertion around output publication;
it cannot establish that assertion or retire an installation itself.

`observeRetiredOperatorRecoveryCheckpoint` authenticates a standard final archive
and retirement receipt, checks the exact on-disk fence, and compares actual
catalog, journal, retained files and runtime with that final checkpoint. It uses
read-only SQLite connections and never constructs a journal writer or acquires
a lease. Only the production lease bookkeeping may differ after permitted final
capture cleanup; other journal content must match. Two observations must agree.
SQLite may create WAL/SHM sidecars during a read, so this is logical read-only
verification rather than a guarantee of unchanged filesystem metadata.

The observer does not cover preparation metadata or dependency inventory omitted
from standard capsules, fresh canonical heads, or a new host. The coordinator must
verify those separately. These storage and observer primitives grant no capture
authority by themselves; the separate coordinator owns the narrow recapture
command. Native composed acceptance and new-host admission remain unfinished.

## Acceptance still required

Format/refusal tests are not a fresh-host rehearsal. Require an actual original
freeze and retirement, deletion of the original roots, genuine frozen recovery
and validation, authenticated recapture and intermediate fencing, deletion of that
host, preparation on a new host, and same-candidate dispatch/retry. Prove no second
import/build, exact retained evidence, both retirement fences and retained
quarantine. Interrupted-build recovery, off-machine durability, operational
credentials/scheduling/monitoring and two observed Friday editions remain open.
